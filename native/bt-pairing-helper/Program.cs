using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Windows.Devices.Bluetooth;
using Windows.Devices.Enumeration;

namespace BtPairingHelper;

/// <summary>
/// One-shot process: pair a single classic Bluetooth device by MAC address through
/// <c>Windows.Devices.Enumeration.DeviceInformationCustomPairing</c>, the WinRT API that does
/// not share the single-callback-slot ceiling that makes <c>bthprops.cpl</c>'s
/// <c>BluetoothRegisterForAuthenticationEx</c> unusable for this (see
/// IMPLEMENTATION_PLAN.md 1.11.13/2.8.17/2.8.18). Spawned fresh per pairing attempt --
/// no daemon, no persistent state.
///
/// Protocol: one JSON object per line on stdout (see <see cref="Emit"/> for the shapes),
/// UTF-8. Exit code carries the outcome: 0 paired (or already paired), 1 pairing failed,
/// 2 unexpected exception, 3 device not found within the inquiry window.
/// </summary>
internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        // Main's own apartment is MTA (a console app's async Task<int> Main cannot be
        // [STAThread]) -- the reason the pairing ceremony below runs on its own STA thread
        // rather than inline. Emitted for the record, not because callers need it.
        Emit(new { type = "apartment", state = Thread.CurrentThread.GetApartmentState().ToString() });

        string? mac = ArgAfter(args, "--mac");
        string pin = ArgAfter(args, "--pin") ?? "1234";
        int inquirySeconds = ParseIntOr(ArgAfter(args, "--inquiry-seconds"), 15);
        int timeoutSeconds = ParseIntOr(ArgAfter(args, "--timeout-seconds"), 90);
        bool scan = Array.IndexOf(args, "--scan") >= 0;

        if (scan)
        {
            // Scan mode exists because nothing else on this host can answer "which bricks are
            // in range right now". The Windows device cache lists only what the machine has
            // already met, so a brick nobody has paired yet is invisible to it -- and that is
            // exactly the brick a user is trying to reach the first time.
            using var scanCts = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));
            try
            {
                return await ScanAsync(TimeSpan.FromSeconds(inquirySeconds), scanCts.Token);
            }
            catch (Exception ex)
            {
                Emit(new { type = "error", message = $"{ex.GetType().Name}: {ex.Message}" });
                return 2;
            }
        }

        if (string.IsNullOrWhiteSpace(mac))
        {
            Emit(new { type = "error", message = "--mac is required (or pass --scan)" });
            return 2;
        }

        try
        {
            // Format check only -- MacToAddress's value isn't needed once the watcher matches
            // by Id string, but a malformed --mac should fail fast rather than run a 15s
            // inquiry that could never have matched anything.
            MacToAddress(mac!);
        }
        catch (Exception ex)
        {
            Emit(new { type = "error", message = $"not a MAC address: {mac} ({ex.Message})" });
            return 2;
        }

        using var overallCts = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));

        try
        {
            // net48's BCL predates nullable-aware attributes, so IsNullOrWhiteSpace above does
            // not narrow mac to non-null for the compiler even though it does at runtime.
            return await RunAsync(mac!, pin, inquirySeconds, overallCts.Token);
        }
        catch (OperationCanceledException)
        {
            Emit(new { type = "error", message = $"timed out after {timeoutSeconds}s" });
            return 2;
        }
        catch (Exception ex)
        {
            Emit(new { type = "error", message = $"{ex.GetType().Name}: {ex.Message}" });
            return 2;
        }
    }

    /// <summary>
    /// How many inquiry windows a pairing gets before it reports NotFound. One window missed a
    /// brick that was in range more than once (plan 2.8.18); the overall --timeout-seconds
    /// still bounds the whole run, so a second window never outlives the process deadline.
    /// </summary>
    private const int MaxInquiryWindows = 2;

    private static async Task<int> RunAsync(
        string mac, string pin, int inquirySeconds, CancellationToken cancellationToken)
    {
        Emit(new { type = "searching", mac });

        // A brick this host already has a bond with is answered from Windows' own records, with
        // no air time. It has to be: the inquiry watcher below is scoped to unpaired devices
        // and cannot see such a brick at all, so without this a paired brick came back
        // NotFound after a full inquiry window (plan 2.8.18, the two-path design).
        var targetSuffix = mac.Replace(":", "").Replace("-", "").ToLowerInvariant();
        var bonded = await DeviceInformation
            .FindAllAsync(BluetoothDevice.GetDeviceSelectorFromPairingState(true))
            .AsTask(cancellationToken);
        foreach (var known in bonded)
        {
            if (!IdMatchesMac(known.Id, targetSuffix)) { continue; }
            Emit(new { type = "found", id = known.Id, name = known.Name, alreadyPaired = true, seen = new List<string>() });
            Emit(new { type = "alreadyPaired", mac });
            return 0;
        }

        DeviceInformation? info = null;
        DeviceWatcher? watcher = null;
        var seen = new List<string>();
        for (var window = 1; window <= MaxInquiryWindows && info is null; window++)
        {
            if (window > 1) { Emit(new { type = "inquiryRetry", window }); }
            (info, seen, watcher) = await WatchForDeviceAsync(mac, TimeSpan.FromSeconds(inquirySeconds), cancellationToken);
        }
        if (info is null)
        {
            Emit(new { type = "result", status = "NotFound", ok = false });
            return 3;
        }

        try
        {
            Emit(new { type = "found", id = info.Id, name = info.Name, alreadyPaired = info.Pairing.IsPaired, seen });

            if (info.Pairing.IsPaired)
            {
                Emit(new { type = "alreadyPaired", mac });
                return 0;
            }

            var result = await PairOnStaThreadAsync(info, pin, cancellationToken);
            var ok = result.Status == DevicePairingResultStatus.Paired;
            Emit(new { type = "result", status = result.Status.ToString(), ok });
            return ok ? 0 : 1;
        }
        finally
        {
            // Kept alive through PairAsync on purpose -- see WatchForDeviceAsync's comment.
            watcher?.Stop();
        }
    }

    /// <summary>
    /// Lists the Bluetooth devices this machine can see right now, paired or not.
    ///
    /// Two queries, because one cannot answer both halves. `GetDeviceSelectorFromPairingState(false)`
    /// is the only selector whose AQS carries `IssueInquiry:=True`, so it is the one that makes
    /// the radio actually scan -- but by construction it excludes everything already paired.
    /// `GetDeviceSelectorFromPairingState(true)` returns those instantly from the host's own
    /// records, no air time. A user picking a brick from a list expects both: the one they have
    /// used before and the one they are meeting for the first time.
    ///
    /// Emits one `device` line per address, deduplicated, then a `scanComplete`.
    /// </summary>
    private static async Task<int> ScanAsync(TimeSpan inquiry, CancellationToken cancellationToken)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var byAddress = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);

        void Report(DeviceInformation info, bool paired)
        {
            var address = AddressFromId(info.Id);
            if (address is null || byAddress.ContainsKey(address)) { return; }
            byAddress[address] = paired;

            info.Properties.TryGetValue("System.Devices.Aep.SignalStrength", out var signal);
            Emit(new
            {
                type = "device",
                mac = address,
                name = info.Name,
                paired,
                signal = signal as int?,
                atMs = sw.ElapsedMilliseconds,
            });
        }

        // Already-paired devices first: they cost nothing and a user should see the brick they
        // know at the top of the list rather than after an inquiry window.
        var paired = await DeviceInformation
            .FindAllAsync(BluetoothDevice.GetDeviceSelectorFromPairingState(true), ScanProperties)
            .AsTask(cancellationToken);
        foreach (var info in paired) { Report(info, true); }

        var watcher = DeviceInformation.CreateWatcher(
            BluetoothDevice.GetDeviceSelectorFromPairingState(false),
            ScanProperties,
            DeviceInformationKind.AssociationEndpoint);

        // A scan is a live view, not a snapshot: bricks are switched on and off and carried in
        // and out of range while a user is looking at the list. So all three events are
        // reported, not just Added -- a brick that has left has to leave the list too, and a
        // signal from twenty seconds ago is not the signal now. (Subscribing to all three is
        // also required by the DeviceWatcher.Updated docs -- see WatchForDeviceAsync.)
        watcher.Added += (_, added) => Report(added, false);
        watcher.Updated += (_, update) =>
        {
            var address = AddressFromId(update.Id);
            if (address is null || !byAddress.ContainsKey(address)) { return; }
            if (!update.Properties.TryGetValue("System.Devices.Aep.SignalStrength", out var signal)) { return; }

            Emit(new
            {
                type = "deviceUpdated",
                mac = address,
                signal = signal as int?,
                atMs = sw.ElapsedMilliseconds,
            });
        };
        watcher.Removed += (_, removed) =>
        {
            var address = AddressFromId(removed.Id);
            if (address is null || !byAddress.Remove(address)) { return; }

            Emit(new { type = "deviceLost", mac = address, atMs = sw.ElapsedMilliseconds });
        };
        watcher.EnumerationCompleted += (_, __) =>
            Emit(new { type = "watcherEnumerationCompleted", status = watcher.Status.ToString(), atMs = sw.ElapsedMilliseconds });

        watcher.Start();
        try
        {
            await Task.Delay(inquiry, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            // The overall deadline, not a fault: report what the scan found before it expired.
        }
        finally
        {
            watcher.Stop();
        }

        Emit(new { type = "scanComplete", count = byAddress.Count, atMs = sw.ElapsedMilliseconds });
        return 0;
    }

    private static readonly string[] ScanProperties = {
        "System.Devices.Aep.DeviceAddress",
        "System.Devices.Aep.IsConnected",
        "System.Devices.Aep.SignalStrength",
    };

    /// <summary>
    /// Pulls the peer address out of an AEP id, which ends in the address, colon-separated.
    /// Returns it colon-separated and uppercase, the spelling the rest of the cockpit uses.
    /// </summary>
    private static string? AddressFromId(string id)
    {
        var dash = id.LastIndexOf('-');
        if (dash < 0 || dash + 1 >= id.Length) { return null; }

        var tail = id.Substring(dash + 1);
        var hex = tail.Replace(":", "");
        if (hex.Length != 12) { return null; }

        var octets = new string[6];
        for (var i = 0; i < 6; i++) { octets[i] = hex.Substring(i * 2, 2).ToUpperInvariant(); }
        return string.Join(":", octets);
    }

    /// <summary>
    /// Runs <c>PairAsync</c> and the <c>PairingRequested</c> ceremony on a dedicated STA
    /// thread with its own Win32 message pump.
    ///
    /// 03.09.2026: <c>PairingRequested</c> never fired in any real run, even with the
    /// watcher kept alive through the whole pairing attempt (ruling out a watcher-lifetime
    /// cause). <c>Main</c>'s apartment state measured MTA -- a console app's
    /// <c>async Task&lt;int&gt; Main</c> cannot be <c>[STAThread]</c>. WinRT event callbacks
    /// raised off a background COM thread need somewhere with a message loop to marshal
    /// into; an MTA thread blocked in an <c>await</c> has none. A
    /// <see cref="System.Windows.Forms.Application.Run()"/> pump on a purpose-built STA
    /// thread is that somewhere -- no window is ever shown, `Application` is only used for
    /// its message loop.
    /// </summary>
    private static Task<DevicePairingResult> PairOnStaThreadAsync(
        DeviceInformation info, string pin, CancellationToken cancellationToken)
    {
        var tcs = new TaskCompletionSource<DevicePairingResult>();

        var thread = new Thread(() =>
        {
            var context = new System.Windows.Forms.WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(context);

            context.Post(async _ =>
            {
                try
                {
                    var customPairing = info.Pairing.Custom;
                    customPairing.PairingRequested += (_, requestArgs) =>
                    {
                        Emit(new { type = "pairingRequested", kind = requestArgs.PairingKind.ToString() });
                        if (requestArgs.PairingKind == DevicePairingKinds.ProvidePin)
                        {
                            requestArgs.Accept(pin);
                        }
                        // Any other kind (DisplayPin, ConfirmPinMatch, ...) is not one EV3's
                        // fixed-1234 legacy pairing can satisfy; offering only ProvidePin
                        // below should keep Windows from negotiating them, but leave this
                        // unhandled rather than Accept() blindly.
                    };

                    var result = await customPairing
                        .PairAsync(DevicePairingKinds.ProvidePin, DevicePairingProtectionLevel.Default)
                        .AsTask(cancellationToken);
                    tcs.SetResult(result);
                }
                catch (Exception ex)
                {
                    tcs.SetException(ex);
                }
                finally
                {
                    System.Windows.Forms.Application.ExitThread();
                }
            }, null);

            System.Windows.Forms.Application.Run();
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.IsBackground = true;
        thread.Start();

        return tcs.Task;
    }

    private static async Task<(DeviceInformation? found, List<string> seen, DeviceWatcher? watcher)> WatchForDeviceAsync(
        string mac, TimeSpan timeout, CancellationToken cancellationToken)
    {
        // Scoped to unpaired devices on purpose: this is the selector whose AQS actually
        // includes `System.Devices.Aep.Bluetooth.IssueInquiry:=True` (confirmed by emitting
        // both AQS strings, 03.09.2026) -- it is the one that makes DAS run a live radio
        // inquiry. `BluetoothDevice.GetDeviceSelector()` looks unfiltered but its AQS is
        // `IsPaired:=True OR IssueInquiry:=False`: paired-only, no inquiry, ever. It will
        // never find a brick this host doesn't already know, regardless of how long you wait.
        // Already-paired bricks are handled as a separate fast path below, not by widening
        // this selector (see [[bt_pairing_winrt_custom_pairing_works]] for the incident that
        // established this).
        var selector = BluetoothDevice.GetDeviceSelectorFromPairingState(false);
        var watcher = DeviceInformation.CreateWatcher(
            selector,
            new[] {
                "System.Devices.Aep.DeviceAddress",
                "System.Devices.Aep.IsConnected",
                "System.Devices.Aep.SignalStrength",
            },
            DeviceInformationKind.AssociationEndpoint);

        var targetSuffix = mac.Replace(":", "").Replace("-", "").ToLowerInvariant();
        DeviceInformation? found = null;
        var seen = new List<string>();
        var gate = new SemaphoreSlim(0);
        var sw = System.Diagnostics.Stopwatch.StartNew();

        watcher.Added += (_, added) =>
        {
            seen.Add($"[{sw.ElapsedMilliseconds}ms] added {added.Id} [{added.Name}] paired={added.Pairing.IsPaired}");
            if (found is null && IdMatchesMac(added.Id, targetSuffix))
            {
                found = added;
                gate.Release();
            }
        };
        // Microsoft's own docs (DeviceWatcher.Updated remarks): "An app must subscribe to all
        // of the added, removed, and updated events to be notified when there are device
        // additions, removals or updates." Confirmed empirically 03.09.2026: a watcher with
        // only Added subscribed lost live-inquiry results after EnumerationCompleted that an
        // otherwise-identical watcher (Added+Updated+Removed+EnumerationCompleted) received.
        // Subscribe to all three even though only Added's payload is used below.
        watcher.Updated += (_, updated) =>
            seen.Add($"[{sw.ElapsedMilliseconds}ms] updated {updated.Id}");
        watcher.Removed += (_, removed) =>
            seen.Add($"[{sw.ElapsedMilliseconds}ms] removed {removed.Id}");
        watcher.EnumerationCompleted += (_, __) =>
            Emit(new { type = "watcherEnumerationCompleted", status = watcher.Status.ToString(), atMs = sw.ElapsedMilliseconds });
        watcher.Stopped += (_, __) =>
            Emit(new { type = "watcherStopped", status = watcher.Status.ToString(), atMs = sw.ElapsedMilliseconds });

        watcher.Start();
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(timeout);
        try
        {
            await gate.WaitAsync(timeoutCts.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // Inquiry window elapsed without a match -- not the overall process timeout.
            Emit(new { type = "inquiryTimedOut", seen, status = watcher.Status.ToString(), atMs = sw.ElapsedMilliseconds });
            watcher.Stop();
            return (null, seen, null);
        }

        // Deliberately not stopped here: a match still leaves PairAsync to run, and there is
        // no reason to tear the watcher down while that is in flight. The caller stops it
        // once pairing is done.
        return (found, seen, watcher);
    }

    /// <summary>
    /// A classic BT AEP id spells the address colon-separated and lowercase, e.g.
    /// "Bluetooth#Bluetooth&lt;radio&gt;-&lt;peer&gt;". Compares against the address with
    /// separators stripped so either spelling on the input side matches.
    /// </summary>
    private static bool IdMatchesMac(string id, string targetSuffixNoSeparators)
    {
        var idNoSeparators = id.Replace(":", "").Replace("-", "").ToLowerInvariant();
        return idNoSeparators.EndsWith(targetSuffixNoSeparators, StringComparison.Ordinal);
    }

    private static ulong MacToAddress(string mac)
    {
        var parts = mac.Split(new[] { ':', '-' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 6)
        {
            throw new FormatException("expected 6 hex octets");
        }

        ulong address = 0;
        foreach (var part in parts)
        {
            address = (address << 8) | byte.Parse(part, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        }
        return address;
    }

    private static string? ArgAfter(string[] args, string flag)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], flag, StringComparison.Ordinal))
            {
                return args[i + 1];
            }
        }
        return null;
    }

    private static int ParseIntOr(string? value, int fallback)
        => int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : fallback;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private static void Emit(object payload)
    {
        Console.WriteLine(JsonSerializer.Serialize(payload, JsonOptions));
        Console.Out.Flush();
    }
}
