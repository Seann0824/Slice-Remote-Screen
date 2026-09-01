import React from "react";
import ReactDOM from "react-dom/client";
import { initializeTheme, ThemeProvider } from "@slice/design-system";
import "@slice/design-system/styles.css";
import App from "./App";
import { P2pControllerScreen } from "./p2p/P2pControllerScreen";
import { P2pHostScreen } from "./p2p/P2pHostScreen";

initializeTheme();

const mode = new URL(window.location.href).searchParams.get("mode");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      {mode === "host" ? (
        <P2pHostScreen />
      ) : mode === "controller" ? (
        <P2pControllerScreen />
      ) : (
        <App />
      )}
    </ThemeProvider>
  </React.StrictMode>,
);
