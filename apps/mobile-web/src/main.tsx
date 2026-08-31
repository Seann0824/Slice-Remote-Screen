import React from "react";
import ReactDOM from "react-dom/client";
import { initializeTheme, ThemeProvider } from "@slice/design-system";
import "@slice/design-system/styles.css";
import App from "./App";

initializeTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);

