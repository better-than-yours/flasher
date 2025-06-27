import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [preact()],
	define: {
		global: "globalThis",
	},
	optimizeDeps: {
		include: ["esptool-js", "crypto-js", "web-serial-polyfill"],
	},
});
