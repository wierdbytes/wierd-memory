import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startLive } from "./hooks.ts";

startLive();
createRoot(document.getElementById("root") as HTMLElement).render(<App />);
