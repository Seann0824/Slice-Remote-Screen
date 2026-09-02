import { useEffect, useRef, useState } from "react";
import { Button } from "@slice/design-system";
import App from "../App";
import { RemoteClientProvider } from "../remote-client-context";
import { AccountLoginCard } from "./AccountLoginCard";
import { DeviceDashboard } from "./DeviceDashboard";
import { signalingSession } from "./signaling";
import { P2pRemoteClient } from "./P2pRemoteClient";

export function P2pAppScreen() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [client, setClient] = useState<P2pRemoteClient | null>(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const connectingClientRef = useRef<P2pRemoteClient | null>(null);

  useEffect(() => {
    void signalingSession()
      .then((session) => setAuthenticated(Boolean(session)))
      .catch((reason) => {
        setAuthenticated(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  function connectToDevice() {
    if (connecting) return;
    setConnecting(true);
    const nextClient = new P2pRemoteClient();
    connectingClientRef.current = nextClient;
    void nextClient.connect()
      .then(() => setClient(nextClient))
      .catch((reason) => {
        nextClient.close();
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (connectingClientRef.current === nextClient) connectingClientRef.current = null;
        setConnecting(false);
      });
  }

  function cancelConnection() {
    connectingClientRef.current?.close();
    connectingClientRef.current = null;
    setConnecting(false);
    setError("已取消连接");
  }

  if (authenticated === false) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl items-center bg-canvas p-4 sm:p-8">
        <AccountLoginCard onAuthenticated={() => { setError(""); setAuthenticated(true); }} />
        {error ? <p className="sr-only">{error}</p> : null}
      </main>
    );
  }

  if (!client) {
    return (
      <>
        <DeviceDashboard onConnect={connectToDevice} />
        {connecting ? (
          <div className="fixed inset-0 z-10 grid place-items-center bg-ink/20 p-6 text-body-sm text-ink backdrop-blur-sm">
            <div className="flex items-center gap-3 rounded-sheet border border-line bg-canvas px-4 py-3 shadow-overlay">
              <span>正在建立点对点连接…</span>
              <Button size="sm" variant="secondary" onClick={cancelConnection}>取消</Button>
            </div>
          </div>
        ) : null}
        {error ? <p className="fixed inset-x-4 bottom-4 z-20 mx-auto max-w-lg rounded-card bg-danger-soft p-4 text-body-sm text-danger-ink shadow-overlay">{error}</p> : null}
      </>
    );
  }

  return (
    <RemoteClientProvider client={client}>
      <App />
    </RemoteClientProvider>
  );
}
