declare global {
	interface Navigator {
		serial?: Serial;
	}

	interface Serial {
		requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
		getPorts(): Promise<SerialPort[]>;
		addEventListener(type: string, listener: EventListener): void;
		removeEventListener(type: string, listener: EventListener): void;
	}

	interface SerialPortRequestOptions {
		filters?: SerialPortFilter[];
	}

	interface SerialPortFilter {
		usbVendorId?: number;
		usbProductId?: number;
	}

	interface SerialPort {
		// Add SerialPort methods as needed
		open(options: SerialOptions): Promise<void>;
		close(): Promise<void>;
		readable: ReadableStream;
		writable: WritableStream;
	}

	interface SerialOptions {
		baudRate: number;
		dataBits?: number;
		stopBits?: number;
		parity?: "none" | "even" | "odd";
		bufferSize?: number;
		flowControl?: "none" | "hardware";
	}
}

export {};
