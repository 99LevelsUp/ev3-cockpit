// The cockpit's Bluetooth helper for macOS (IMPLEMENTATION_PLAN item 8, the Mac visit, 18.11.2026).
//
// macOS gives a paired EV3 a serial port (/dev/cu.<name>), but on macOS 27 opening it never brings
// up the RFCOMM link: the writes "succeed" and nothing reaches the brick. IOBluetooth does open
// the channel (measured on an M4: 1.2 s to open, 60 ms for a reply). Node has no binding to it, so
// this helper does the Bluetooth part and the cockpit talks to it over pipes.
//
//   ev3-bt-helper list           JSON on stdout: the paired devices, or {"error": ...}
//   ev3-bt-helper connect <mac>  stdin -> brick, brick -> stdout, raw bytes; status lines on stderr:
//                                "open <mtu>" once the channel is up, "error <text>" on failure,
//                                "closed" when the brick or the radio ends it. EOF on stdin closes.
//
// Bluetooth needs the user's consent (TCC). The prompt names the app that started the helper (VS
// Code, or the Terminal), never the helper. Before consent IOBluetooth answers as if nothing were
// paired, so both commands first wait for the answer and report a refusal as such.
//
// Build: swiftc -O -o native/bin/ev3-bt-helper native/macos/ev3-bt-helper.swift

import Foundation
import IOBluetooth
import CoreBluetooth

func status(_ line: String) {
	FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
}

func fail(_ text: String, code: Int32) -> Never {
	status("error " + text)
	exit(code)
}

// ── Consent ──────────────────────────────────────────────────────────

final class ConsentWaiter: NSObject, CBCentralManagerDelegate {
	var manager: CBCentralManager?
	var done = false
	func centralManagerDidUpdateState(_ central: CBCentralManager) { done = true }
}

/** Waits for the user's answer when nobody has asked yet; false when Bluetooth is refused. */
func bluetoothAllowed() -> Bool {
	switch CBManager.authorization {
	case .allowedAlways: return true
	case .denied, .restricted: return false
	case .notDetermined:
		// Creating a manager asks; its first state update comes once the user has answered.
		let waiter = ConsentWaiter()
		waiter.manager = CBCentralManager(delegate: waiter, queue: nil)
		let deadline = Date().addingTimeInterval(120)
		while !waiter.done && Date() < deadline {
			RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.2))
		}
		return CBManager.authorization == .allowedAlways
	@unknown default: return false
	}
}

func bareMac(_ address: String?) -> String {
	return (address ?? "").lowercased().filter { $0.isHexDigit }
}

// ── list ─────────────────────────────────────────────────────────────

func list() -> Never {
	guard bluetoothAllowed() else {
		print("{\"error\":\"denied\"}")
		exit(3)
	}
	let devices = (IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice]) ?? []
	let rows: [[String: Any]] = devices.map { device in [
		"mac": bareMac(device.addressString),
		"name": device.name ?? "",
		"connected": device.isConnected(),
		"classOfDevice": Int(device.classOfDevice),
	] }
	let data = try! JSONSerialization.data(withJSONObject: ["devices": rows])
	FileHandle.standardOutput.write(data)
	FileHandle.standardOutput.write("\n".data(using: .utf8)!)
	exit(0)
}

// ── connect ──────────────────────────────────────────────────────────

final class Link: NSObject, IOBluetoothRFCOMMChannelDelegate {
	var channel: IOBluetoothRFCOMMChannel?

	func rfcommChannelData(_ channel: IOBluetoothRFCOMMChannel!, data pointer: UnsafeMutableRawPointer!, length: Int) {
		FileHandle.standardOutput.write(Data(bytes: pointer, count: length))
	}

	func rfcommChannelClosed(_ channel: IOBluetoothRFCOMMChannel!) {
		status("closed")
		exit(0)
	}

	/** Writes what came on stdin, in pieces the channel's MTU allows. On the main thread. */
	func write(_ data: Data) {
		guard let channel = channel else { return }
		let mtu = max(1, Int(channel.getMTU()))
		var offset = 0
		while offset < data.count {
			var piece = data.subdata(in: offset..<min(offset + mtu, data.count))
			let result = piece.withUnsafeMutableBytes { channel.writeSync($0.baseAddress, length: UInt16($0.count)) }
			if result != kIOReturnSuccess { fail("write failed (\(result))", code: 5) }
			offset += piece.count
		}
	}
}

func connect(_ address: String) -> Never {
	guard bluetoothAllowed() else { fail("Bluetooth access is refused for this app", code: 3) }
	let bare = bareMac(address)
	guard bare.count == 12 else { fail("not an address: \(address)", code: 2) }
	let dashed = stride(from: 0, to: 12, by: 2).map { i -> String in
		let start = bare.index(bare.startIndex, offsetBy: i)
		return String(bare[start..<bare.index(start, offsetBy: 2)])
	}.joined(separator: "-")
	guard let device = IOBluetoothDevice(addressString: dashed) else { fail("no device \(dashed)", code: 4) }

	// The brick's Serial Port service, from the record macOS cached at pairing; the EV3's is 1.
	var channelID: BluetoothRFCOMMChannelID = 1
	for record in (device.services as? [IOBluetoothSDPServiceRecord]) ?? [] {
		var id: BluetoothRFCOMMChannelID = 0
		if record.getRFCOMMChannelID(&id) == kIOReturnSuccess { channelID = id; break }
	}

	let link = Link()
	var channel: IOBluetoothRFCOMMChannel?
	let opened = device.openRFCOMMChannelSync(&channel, withChannelID: channelID, delegate: link)
	guard opened == kIOReturnSuccess, let open = channel else { fail("RFCOMM open failed (\(opened))", code: 4) }
	link.channel = open
	status("open \(open.getMTU())")

	FileHandle.standardInput.readabilityHandler = { handle in
		let data = handle.availableData
		DispatchQueue.main.async {
			if data.isEmpty {
				// The cockpit closed its end: close the channel and leave.
				link.channel?.close()
				exit(0)
			}
			link.write(data)
		}
	}
	RunLoop.main.run()
	exit(0)
}

// ── forget ───────────────────────────────────────────────────────────

/**
 * Removes the Mac's pairing with a device. A brick reset without a clean shutdown loses its side of
 * the pairing while macOS keeps its key; the brick then offers to pair on every connect and macOS
 * never takes it up (the Mac visit, 18.11.2026), and the system settings offer no way out there.
 * IOBluetooth's `remove` is not public API; it is what blueutil and similar tools call.
 */
func forget(_ address: String) -> Never {
	guard bluetoothAllowed() else { fail("Bluetooth access is refused for this app", code: 3) }
	let bare = bareMac(address)
	guard bare.count == 12 else { fail("not an address: \(address)", code: 2) }
	let dashed = stride(from: 0, to: 12, by: 2).map { i -> String in
		let start = bare.index(bare.startIndex, offsetBy: i)
		return String(bare[start..<bare.index(start, offsetBy: 2)])
	}.joined(separator: "-")
	guard let device = IOBluetoothDevice(addressString: dashed) else { fail("no device \(dashed)", code: 4) }
	if !device.isPaired() { status("not paired"); exit(0) }
	let remove = Selector(("remove"))
	guard device.responds(to: remove) else { fail("this macOS offers no way to remove a pairing", code: 6) }
	device.perform(remove)
	let deadline = Date().addingTimeInterval(5)
	while device.isPaired() && Date() < deadline {
		RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.2))
	}
	if device.isPaired() { fail("the pairing is still there", code: 6) }
	status("forgotten")
	exit(0)
}

// ── main ─────────────────────────────────────────────────────────────

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "list": list()
case "connect" where args.count > 2: connect(args[2])
case "forget" where args.count > 2: forget(args[2])
default:
	status("usage: ev3-bt-helper list | connect <mac> | forget <mac>")
	exit(2)
}
