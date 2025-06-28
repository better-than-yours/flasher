import CryptoJS from "crypto-js";
import {
	ESPLoader,
	type FlashOptions,
	type LoaderOptions,
	Transport,
} from "esptool-js";
import { useRef, useState } from "preact/hooks";
import { serial } from "web-serial-polyfill";
import tDisplays3releases from "./firmwares/dashboard-lilygo-t-displays3-releases.json";

function useSerialConnection(baudrate: string) {
	const [isConnected, setIsConnected] = useState(false);
	const [chip, setChip] = useState<string | null>(null);

	const deviceRef = useRef<any>(null);
	const transportRef = useRef<Transport | null>(null);
	const espLoaderRef = useRef<ESPLoader | null>(null);
	const serialPortRef = useRef<any>(null);
	const writerRef = useRef<WritableStreamDefaultWriter | null>(null);
	const readerRef = useRef<ReadableStreamDefaultReader | null>(null);

	const serialLib =
		!navigator.serial && (navigator as any).usb ? serial : navigator.serial;

	const terminal = {
		clean() {},
		writeLine: console.log,
		write: console.log,
	};

	const setupNativeSerial = async () => {
		serialPortRef.current = await serialLib?.requestPort({});
		await serialPortRef.current.open({ baudRate: parseInt(baudrate) });
		writerRef.current = serialPortRef.current.writable.getWriter();
		readerRef.current = serialPortRef.current.readable.getReader();
		deviceRef.current = serialPortRef.current;
		setChip("Native Connection");
	};

	const closeNativeSerial = async () => {
		if (readerRef.current) {
			await readerRef.current.cancel();
			readerRef.current.releaseLock();
			readerRef.current = null;
		}
		if (writerRef.current) {
			await writerRef.current.close();
			writerRef.current = null;
		}
		if (serialPortRef.current?.readable) {
			await serialPortRef.current.close();
			serialPortRef.current = null;
		}
	};

	const setupESPTool = async () => {
		if (!deviceRef.current) throw new Error("No device available");

		transportRef.current = new Transport(deviceRef.current, true);
		espLoaderRef.current = new ESPLoader({
			transport: transportRef.current,
			baudrate: parseInt(baudrate),
			terminal,
			debugLogging: false,
			romBaudrate: parseInt(baudrate),
		} as LoaderOptions);

		const detectedChip = await espLoaderRef.current.main();
		setChip(detectedChip);
		return detectedChip;
	};

	const cleanupESPTool = async () => {
		if (transportRef.current) {
			await transportRef.current.disconnect();
			transportRef.current = null;
		}
		espLoaderRef.current = null;
	};

	const connect = async () => {
		await setupNativeSerial();
		setIsConnected(true);
	};

	const disconnect = async () => {
		await closeNativeSerial();
		await cleanupESPTool();
		setIsConnected(false);
		setChip(null);
		deviceRef.current = null;
	};

	const sendCommand = async (command: string): Promise<string> => {
		if (!writerRef.current || !readerRef.current) {
			throw new Error("Native serial not connected");
		}

		const encoder = new TextEncoder();
		await writerRef.current.write(encoder.encode(`${command}\n`));

		let response = "";
		const decoder = new TextDecoder();
		const startTime = Date.now();
		const timeout = 2000;

		while (Date.now() - startTime < timeout) {
			try {
				const readPromise = readerRef.current.read();
				const timeoutPromise = new Promise<
					ReadableStreamReadResult<Uint8Array>
				>((_, reject) =>
					setTimeout(() => reject(new Error("Read timeout")), 1000),
				);

				const result = await Promise.race([readPromise, timeoutPromise]);
				if (result.value?.length > 0) {
					const chunk = decoder.decode(result.value);
					response += chunk;

					if (response.includes("END") || response.includes("ERROR")) {
						break;
					}
				}
				if (result.done) break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}

		return response.trim();
	};

	return {
		isConnected,
		chip,
		connect,
		disconnect,
		sendCommand,
		setupESPTool,
		cleanupESPTool,
		setupNativeSerial,
		closeNativeSerial,
		espLoaderRef,
	};
}

function useFlashOperations(serial: ReturnType<typeof useSerialConnection>) {
	const [isErasing, setIsErasing] = useState(false);
	const [isProgramming, setIsProgramming] = useState(false);
	const [progress, setProgress] = useState(0);

	const eraseFlash = async () => {
		setIsErasing(true);
		try {
			await serial.closeNativeSerial();
			await serial.setupESPTool();
			await serial.espLoaderRef.current?.eraseFlash();
			await serial.cleanupESPTool();
			await new Promise((resolve) => setTimeout(resolve, 1000));
			await serial.setupNativeSerial();
		} finally {
			setIsErasing(false);
		}
	};

	const programFlash = async (fileData: string) => {
		setIsProgramming(true);
		setProgress(0);
		try {
			await serial.closeNativeSerial();
			await serial.setupESPTool();

			await serial.espLoaderRef.current?.writeFlash({
				fileArray: [{ data: fileData, address: 0x10000 }],
				flashSize: "keep",
				flashMode: "keep",
				flashFreq: "keep",
				eraseAll: false,
				compress: true,
				reportProgress: (_: number, written: number, total: number) => {
					setProgress((written / total) * 100);
				},
				calculateMD5Hash: (image: string) => {
					return CryptoJS.MD5(CryptoJS.enc.Latin1.parse(image)).toString();
				},
			} as FlashOptions);

			await serial.espLoaderRef.current?.after("hard_reset");
			await serial.cleanupESPTool();
			await new Promise((resolve) => setTimeout(resolve, 2000));
			await serial.setupNativeSerial();
		} finally {
			setIsProgramming(false);
			setProgress(0);
		}
	};

	return {
		isErasing,
		isProgramming,
		progress,
		eraseFlash,
		programFlash,
	};
}

function usePreferences(serial: ReturnType<typeof useSerialConnection>) {
	const [preferences, setPreferences] = useState("");
	const [isLoadingPrefs, setIsLoadingPrefs] = useState(false);
	const [isUpdatingPrefs, setIsUpdatingPrefs] = useState(false);

	const getAllSettings = async () => {
		setIsLoadingPrefs(true);
		try {
			const response = await serial.sendCommand("GET_ALL_PREFS");
			if (response) {
				try {
					const jsonData = JSON.parse(response);
					setPreferences(JSON.stringify(jsonData, null, 2));
				} catch {
					setPreferences(response);
				}
			} else {
				throw new Error("No response received from device");
			}
		} finally {
			setIsLoadingPrefs(false);
		}
	};

	const updateAllSettings = async () => {
		if (!preferences.trim()) throw new Error("No preferences data!");

		setIsUpdatingPrefs(true);
		try {
			const prefsData = JSON.parse(preferences);
			const response = await serial.sendCommand(
				`SET_ALL_PREFS:${JSON.stringify(prefsData)}`,
			);
			if (response.includes("ERROR")) {
				throw new Error(`Update failed: ${response}`);
			}
			return `Response: ${response}`;
		} finally {
			setIsUpdatingPrefs(false);
		}
	};

	return {
		preferences,
		setPreferences,
		isLoadingPrefs,
		isUpdatingPrefs,
		getAllSettings,
		updateAllSettings,
	};
}

function useFirmwareLoader() {
	const [selectedVersion, setSelectedVersion] = useState<string>("");
	const [firmwareData, setFirmwareData] = useState<string | null>(null);
	const [isLoadingFirmware, setIsLoadingFirmware] = useState(false);

	const loadFirmware = async (version: string) => {
		if (!version) {
			throw new Error("No version selected");
		}

		setIsLoadingFirmware(true);
		try {
			const firmwarePath = `./firmwares/${version}/dashboard-lilygo-t-displays3.bin`;
			const response = await fetch(firmwarePath);

			if (!response.ok) {
				throw new Error(
					`Failed to load firmware: ${response.status} ${response.statusText}`,
				);
			}

			const arrayBuffer = await response.arrayBuffer();
			const uint8Array = new Uint8Array(arrayBuffer);
			let binaryString = "";
			for (let i = 0; i < uint8Array.length; i++) {
				binaryString += String.fromCharCode(uint8Array[i]);
			}

			setFirmwareData(binaryString);
			return binaryString;
		} finally {
			setIsLoadingFirmware(false);
		}
	};

	const handleVersionChange = async (version: string) => {
		setSelectedVersion(version);
		setFirmwareData(null);
		if (version) {
			await loadFirmware(version);
		}
	};

	return {
		selectedVersion,
		firmwareData,
		isLoadingFirmware,
		loadFirmware,
		handleVersionChange,
	};
}

function useErrorHandler() {
	const [alert, setAlert] = useState("");

	const handleError = (error: any, context: string) => {
		console.error(error);
		const message = error.message?.includes("JSON")
			? "Invalid JSON format in preferences"
			: `${context}: ${error.message}`;
		setAlert(message);
	};

	const clearAlert = () => setAlert("");

	return { alert, setAlert, handleError, clearAlert };
}

export function App() {
	const [baudrate, setBaudrate] = useState("115200");
	const { alert, setAlert, handleError, clearAlert } = useErrorHandler();
	const serial = useSerialConnection(baudrate);
	const flash = useFlashOperations(serial);
	const preferences = usePreferences(serial);
	const firmware = useFirmwareLoader();

	const handleConnect = async () => {
		try {
			await serial.connect();
		} catch (e: any) {
			handleError(e, "Connection failed");
		}
	};

	const handleDisconnect = async () => {
		await serial.disconnect();
		clearAlert();
		preferences.setPreferences("");
	};

	const handleEraseFlash = async () => {
		try {
			await flash.eraseFlash();
		} catch (e: any) {
			handleError(e, "Erase failed");
		}
	};

	const handleProgram = async () => {
		if (!firmware.firmwareData) {
			handleError(
				new Error("No firmware loaded! Please select a version first."),
				"Programming failed",
			);
			return;
		}

		try {
			clearAlert();
			await flash.programFlash(firmware.firmwareData);
			setAlert("Programming completed successfully!");
		} catch (e: any) {
			handleError(e, "Programming failed");
		}
	};

	const handleGetAllSettings = async () => {
		try {
			clearAlert();
			await preferences.getAllSettings();
		} catch (error: any) {
			handleError(error, "Error getting settings");
		}
	};

	const handleUpdateAllSettings = async () => {
		try {
			clearAlert();
			const result = await preferences.updateAllSettings();
			setAlert(result);
		} catch (error: any) {
			handleError(error, "Error updating settings");
		}
	};

	const handleVersionSelect = async (event: Event) => {
		const version = (event.target as HTMLSelectElement).value;
		try {
			clearAlert();
			await firmware.handleVersionChange(version);
		} catch (error: any) {
			handleError(error, "Failed to load firmware");
		}
	};

	return (
		<div>
			<h3>Flasher</h3>

			{!serial.isConnected ? (
				<div>
					<label>Baudrate: </label>
					<select
						value={baudrate}
						onChange={(e) => setBaudrate((e.target as HTMLSelectElement).value)}
					>
						<option value="921600">921600</option>
						<option value="460800">460800</option>
						<option value="230400">230400</option>
						<option value="115200">115200</option>
					</select>
					<button onClick={handleConnect}>Connect</button>
				</div>
			) : (
				<div>
					<p>Connected to: {serial.chip}</p>
					<button onClick={handleDisconnect}>Disconnect</button>
					<button onClick={handleEraseFlash} disabled={flash.isErasing}>
						{flash.isErasing ? "Erasing..." : "Erase Flash"}
					</button>
				</div>
			)}

			{alert && (
				<div>
					{alert}
					<button onClick={clearAlert}>×</button>
				</div>
			)}

			{serial.isConnected && !flash.isErasing && (
				<div>
					<div>
						<label>Firmware Version: </label>
						<select
							value={firmware.selectedVersion}
							onChange={handleVersionSelect}
							disabled={firmware.isLoadingFirmware}
						>
							<option value="">Select firmware version...</option>
							{tDisplays3releases.map((release) => (
								<option key={release.version} value={release.version}>
									{release.version}
								</option>
							))}
						</select>
						{firmware.isLoadingFirmware && <span> Loading firmware...</span>}
						{firmware.firmwareData && <span> ✓ Firmware loaded</span>}
					</div>

					{flash.isProgramming && (
						<div>
							<progress value={flash.progress} max="100" />
							<div>{Math.round(flash.progress)}%</div>
						</div>
					)}

					<button
						onClick={handleProgram}
						disabled={
							flash.isProgramming ||
							!firmware.firmwareData ||
							firmware.isLoadingFirmware
						}
					>
						{flash.isProgramming ? "Programming..." : "Program"}
					</button>

					<hr />

					<h4>Device Preferences</h4>

					<div>
						<button
							onClick={handleGetAllSettings}
							disabled={
								preferences.isLoadingPrefs || preferences.isUpdatingPrefs
							}
						>
							{preferences.isLoadingPrefs ? "Loading..." : "Get All Settings"}
						</button>

						<button
							onClick={handleUpdateAllSettings}
							disabled={
								preferences.isLoadingPrefs ||
								preferences.isUpdatingPrefs ||
								!preferences.preferences.trim()
							}
						>
							{preferences.isUpdatingPrefs
								? "Updating..."
								: "Update All Settings"}
						</button>

						<button
							onClick={async () =>
								preferences.setPreferences(await serial.sendCommand("PING"))
							}
							disabled={
								preferences.isLoadingPrefs || preferences.isUpdatingPrefs
							}
						>
							PING
						</button>
					</div>

					<textarea
						value={preferences.preferences}
						onChange={(e) =>
							preferences.setPreferences(
								(e.target as HTMLTextAreaElement).value,
							)
						}
						placeholder="Device preferences will appear here..."
						rows={15}
						cols={80}
						disabled={preferences.isLoadingPrefs || preferences.isUpdatingPrefs}
					/>
				</div>
			)}
		</div>
	);
}
