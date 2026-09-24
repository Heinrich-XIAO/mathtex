import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

export type InstallMode = "install" | "ios" | null;

// Module-level capture: beforeinstallprompt can fire before React mounts.
let captured: BeforeInstallPromptEvent | null = null;
window.addEventListener(
  "beforeinstallprompt",
  (e) => {
    if (!window.matchMedia("(display-mode: standalone)").matches) {
      e.preventDefault();
      captured = e as BeforeInstallPromptEvent;
    }
  },
  { once: true },
);

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function useInstall(): {
  mode: InstallMode;
  install: () => void;
  dismiss: () => void;
} {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(captured);
  const [mode, setMode] = useState<InstallMode>(() => {
    if (captured) return "install";
    if (!isStandalone() && isIos()) return "ios";
    return null;
  });
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem("mathtex-install-hint") === "off",
  );

  useEffect(() => {
    if (isStandalone()) return;
    if (captured && deferred !== captured) setDeferred(captured);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      const ev = e as BeforeInstallPromptEvent;
      captured = ev;
      setDeferred(ev);
      setMode("install");
    };
    const onInstalled = () => setMode(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if (!captured && isIos() && !dismissed) setMode((m) => m ?? "ios");
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [deferred, dismissed]);

  const install = useCallback(() => {
    if (!deferred) return;
    void deferred.prompt().finally(() => {
      captured = null;
      setDeferred(null);
      setMode(null);
    });
  }, [deferred]);

  const dismiss = useCallback(() => {
    localStorage.setItem("mathtex-install-hint", "off");
    setDismissed(true);
    setMode(null);
  }, []);

  return { mode, install, dismiss };
}
