import "./index.css";

import { createRoot } from "react-dom/client";

import { App } from "./app";
import { createReadState } from "./lib/read-state";

// Read state starts at the first launch that has it: every job found before counts as read.
createReadState(localStorage);

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
