import type { MockBrickConfig } from '../mockTypes';
import type { LedPattern } from '../../device/ledService';

// ---------------------------------------------------------------------------
// MockBrickState — holds brick-level settings + peripherals
// ---------------------------------------------------------------------------

export class MockBrickState {
	private name: string;
	private firmwareVersion: string;
	private batteryVoltage: number;
	private batteryCurrent: number;
	private batteryDrainRate: number;
	private volume: number;
	private sleepMinutes: number;
	private ledPattern: LedPattern;
	/** Bitmask of currently "pressed" buttons (0 = none). */
	private buttonPress: number;

	public constructor(config: MockBrickConfig) {
		this.name = config.name;
		this.firmwareVersion = config.firmwareVersion;
		this.batteryVoltage = config.batteryVoltage;
		this.batteryCurrent = config.batteryCurrent;
		this.batteryDrainRate = config.batteryDrainRate;
		this.volume = config.volume;
		this.sleepMinutes = config.sleepMinutes;
		this.ledPattern = 1; // green = normal running state
		this.buttonPress = 0;
	}

	/** Advance battery drain. drainRate is V/hour, deltaMs in milliseconds. */
	public tick(deltaMs: number): void {
		if (this.batteryDrainRate > 0) {
			const drainV = (this.batteryDrainRate / 3_600_000) * deltaMs;
			this.batteryVoltage = Math.max(0, this.batteryVoltage - drainV);
		}
	}

	// -- Name ----------------------------------------------------------------

	public getName(): string { return this.name; }

	public setName(name: string): void {
		this.name = name.substring(0, 12);
	}

	// -- Firmware ------------------------------------------------------------

	public getFirmwareVersion(): string { return this.firmwareVersion; }

	// -- Battery -------------------------------------------------------------

	public getBatteryVoltage(): number { return this.batteryVoltage; }

	public getBatteryCurrent(): number { return this.batteryCurrent; }

	// -- Volume --------------------------------------------------------------

	public getVolume(): number { return this.volume; }

	public setVolume(vol: number): void {
		this.volume = Math.max(0, Math.min(100, Math.round(vol)));
	}

	// -- Sleep ---------------------------------------------------------------

	public getSleepMinutes(): number { return this.sleepMinutes; }

	public setSleepMinutes(min: number): void {
		this.sleepMinutes = Math.max(0, Math.round(min));
	}

	// -- LED -----------------------------------------------------------------

	public getLedPattern(): LedPattern { return this.ledPattern; }

	public setLedPattern(pattern: LedPattern): void {
		this.ledPattern = pattern;
	}

	// -- Buttons -------------------------------------------------------------

	public getButtonPress(): number { return this.buttonPress; }

	/** Simulate pressing a button (value from opUI_READ GET_PRESS). */
	public setButtonPress(value: number): void {
		this.buttonPress = value;
	}
}
