import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

// No StrictMode: its double-mount would open and tear down the OPFS database and sockets twice.
createRoot(document.getElementById("root")!).render(<App />);
