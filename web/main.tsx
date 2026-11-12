import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@feltdb/feltkit/client";
import { FeltKitProvider } from "@feltdb/feltkit/react";
import { App } from "./App";
import "./styles.css";

// Same origin as the page. In a browser the client keeps the session in FeltKit's HttpOnly cookie
// and sends the CSRF token the server issues; the page never sees a session token.
const client = createClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FeltKitProvider client={client}>
      <App />
    </FeltKitProvider>
  </StrictMode>,
);
