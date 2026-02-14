export interface BrickSpec {
	cpu?: {
		model?: string;
		mhz?: number;
	};
	ramMb?: number;
	flashMb?: number;
	eepromKb?: number;
	os?: string;
	ports?: {
		inputs?: number;
		outputs?: number;
		connector?: string;
		inputAnalogRangeV?: string;
		uartKbps?: {
			port1_2?: number;
			port3_4?: number;
		};
		i2cKbps?: number;
		i2cBufferBytes?: number;
		outputCurrentMa?: {
			continuous?: number;
			peak?: number;
		};
		outputType?: string;
		thermalProtection?: boolean;
		encoder?: boolean;
	};
	usb?: {
		client?: string;
		host?: string;
	};
	bluetooth?: {
		version?: string;
		module?: string;
		profile?: string;
		rangeMeters?: number;
		maxConnections?: number;
	};
	wifi?: {
		support?: string;
		dongle?: string;
	};
	sd?: {
		type?: string;
	};
	display?: {
		resolution?: string;
		type?: string;
		sizeMm?: string;
		controller?: string;
		spiMhz?: number;
		buttons?: number;
		led?: string;
	};
	audio?: {
		speakerDiameterMm?: number;
		impedanceOhm?: number;
		amplifier?: string;
		maxW?: number;
	};
	power?: {
		battery?: string;
		aaRecommended?: string;
		liIon?: string;
		polySwitchCount?: number;
		polySwitchHoldA?: number;
		polySwitchTripA?: number;
	};
	daisyChain?: {
		maxBricks?: number;
		portsTotal?: string;
		connection?: string;
		speedMbit?: number;
		updateMs?: number;
	};
}

export interface BrickIdentity {
	name?: string;
	serialNumber?: string;
	bluetoothMac?: string;
	wifiMac?: string;
}

export interface BrickVersions {
	osVersion?: string;
	osBuild?: string;
	fwVersion?: string;
	fwBuild?: string;
	hwVersion?: string;
	componentVersion?: string;
}

export interface BrickPower {
	batteryVoltage?: number;
	batteryLevel?: number;
	batteryCurrent?: number;
	motorCurrent?: number;
}

export interface BrickStorage {
	totalMemoryBytes?: number;
	freeMemoryBytes?: number;
	sdPresent?: boolean;
}

export interface BrickComms {
	bluetooth?: {
		on?: boolean;
		visible?: boolean;
		pin?: string;
		paired?: string[];
		discovered?: string[];
	};
	wifi?: {
		on?: boolean;
		present?: boolean;
		encryption?: string;
		ssid?: string;
	};
}

export interface BrickUiSettings {
	volume?: number;
	sleepMinutes?: number;
	error?: string;
}

export interface BrickDisplayInfo {
	width: number;
	height: number;
	bpp: number;
	bufferBytes?: number;
	bmpBase64?: string;
	rawBase64?: string;
}

export interface BrickProgramInfo {
	status?: number;
	speed?: number;
	result?: number;
}

export interface BrickSensorInfo {
	port: number;
	typeCode?: number;
	mode?: number;
	connected?: boolean;
	typeName?: string;
	connection?: number;
	siValue?: number;
}

export interface BrickMotorInfo {
	port: string;
	typeCode?: number;
	tachoPosition?: number;
	connection?: number;
}

export interface BrickPortsSnapshot {
	sensors?: BrickSensorInfo[];
	motors?: BrickMotorInfo[];
	deviceTypes?: number[];
	deviceTypesChanged?: number;
}

export interface BrickFilesystemFile {
	type: 'file';
	name: string;
	sizeBytes?: number;
	md5?: string;
	text?: string;
	base64?: string;
}

export interface BrickFilesystemDir {
	type: 'dir';
	name: string;
	children: BrickFilesystemNode[];
}

export type BrickFilesystemNode = BrickFilesystemDir | BrickFilesystemFile;

export interface BrickFilesystemRoot {
	path: string;
	nodes: BrickFilesystemNode[];
	truncated?: boolean;
	error?: string;
}

export interface BrickFilesystemSnapshot {
	roots: BrickFilesystemRoot[];
}

export interface BrickDefinitionNode {
	name?: string;
	spec?: BrickSpec;
	identity?: BrickIdentity;
	versions?: BrickVersions;
	power?: BrickPower;
	storage?: BrickStorage;
	comms?: BrickComms;
	ui?: BrickUiSettings;
	display?: BrickDisplayInfo;
	program?: BrickProgramInfo;
	ports?: BrickPortsSnapshot;
	filesystem?: BrickFilesystemSnapshot;
	bricks?: BrickDefinitionNode[];
}

export interface BrickSnapshot extends BrickDefinitionNode {
	brickId: string;
	displayName: string;
	transport: string;
	detail?: string;
	capturedAtIso: string;
	errors?: string[];
}
