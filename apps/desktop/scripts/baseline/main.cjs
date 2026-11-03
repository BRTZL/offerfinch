// Electron hello world for comparison: one sandboxed window with a heading, or none (--hidden).
const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.BASE_DATA);
const t0 = Date.now();
const background = process.env.OFFERFINCH_TEST_BACKGROUND === "1";
if (background && process.platform === "darwin") {
	app.setActivationPolicy("accessory");
	app.dock?.hide();
}
app.whenReady().then(() => {
	if (process.argv.includes("--hidden")) return;
	const w = new BrowserWindow({
		width: 1200,
		height: 800,
		show: false,
		webPreferences: { sandbox: true, contextIsolation: true },
	});
	w.once("ready-to-show", () => {
		if (!background) w.show();
		console.log("shown", Date.now() - t0);
	});
	w.loadURL("data:text/html,<h1>Hello</h1>");
});
app.on("window-all-closed", () => {});
