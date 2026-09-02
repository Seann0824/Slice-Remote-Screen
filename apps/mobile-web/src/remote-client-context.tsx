import { createContext, useContext, type ReactNode } from "react";
import type { RemoteClient } from "./remote-client";

const RemoteClientContext = createContext<RemoteClient | null>(null);

export function RemoteClientProvider({ client, children }: { client: RemoteClient; children: ReactNode }) {
  return <RemoteClientContext.Provider value={client}>{children}</RemoteClientContext.Provider>;
}

export function useRemoteClient() {
  const client = useContext(RemoteClientContext);
  if (!client) throw new Error("RemoteClientProvider is missing");
  return client;
}
