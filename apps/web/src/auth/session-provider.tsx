"use client";

import type { SessionProfile } from "@battlefield/contracts";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { getSession, logout } from "./api-client";

type SessionStatus = "loading" | "authenticated" | "anonymous";

interface SessionContextValue {
  status: SessionStatus;
  session: SessionProfile | null;
  setAuthenticatedSession(session: SessionProfile): void;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  children,
  initialSession,
}: {
  children: ReactNode;
  initialSession?: SessionProfile | null;
}) {
  const shouldLoad = initialSession === undefined;
  const [status, setStatus] = useState<SessionStatus>(
    shouldLoad ? "loading" : initialSession ? "authenticated" : "anonymous",
  );
  const [session, setSession] = useState<SessionProfile | null>(
    initialSession ?? null,
  );

  useEffect(() => {
    if (!shouldLoad) return;
    let active = true;
    void getSession()
      .then((loaded) => {
        if (!active) return;
        setSession(loaded);
        setStatus("authenticated");
      })
      .catch(() => {
        if (!active) return;
        setSession(null);
        setStatus("anonymous");
      });
    return () => {
      active = false;
    };
  }, [shouldLoad]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      session,
      setAuthenticatedSession(loaded) {
        setSession(loaded);
        setStatus("authenticated");
      },
      async signOut() {
        await logout();
        setSession(null);
        setStatus("anonymous");
      },
    }),
    [session, status],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useSession must be rendered inside SessionProvider.");
  }
  return context;
}

export function useOptionalSession(): SessionContextValue | null {
  return useContext(SessionContext);
}
