// autoscaler/src/index.js
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";

// Monta l'app su #root
const root = createRoot(document.getElementById("root"));
root.render(<App />);