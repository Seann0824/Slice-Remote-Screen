import React from "react";
import ReactDOM from "react-dom/client";
import { initializeTheme, ThemeProvider } from "@slice/design-system";
import "@slice/design-system/styles.css";
import App from "./App";
import { localRemoteClient } from "./local-remote-client";
import { RemoteClientProvider } from "./remote-client-context";
import { P2pAppScreen } from "./p2p/P2pAppScreen";
import { P2pControllerScreen } from "./p2p/P2pControllerScreen";
import { P2pHostScreen } from "./p2p/P2pHostScreen";

initializeTheme();

const mode = new URL(window.location.href).searchParams.get("mode");
const p2pByDefault = import.meta.env.VITE_DEFAULT_TRANSPORT === "p2p";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      {mode === "host" ? (
        <P2pHostScreen />
      ) : mode === "controller" ? (
        <P2pControllerScreen />
      ) : mode === "p2p" || (!mode && p2pByDefault) ? (
        <P2pAppScreen />
      ) : (
        <RemoteClientProvider client={localRemoteClient}>
          <App />
        </RemoteClientProvider>
      )}
    </ThemeProvider>
  </React.StrictMode>,
);
