"use client";

import { useEffect } from "react";
import { useAppStore } from "@/stores/use-app-store";

export function AppTheme() {
  const mode = useAppStore((state) => state.themeMode);
  const color = useAppStore((state) => state.themeColor);

  useEffect(() => {
    document.documentElement.dataset.themeColor = color;
  }, [color]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = mode === "dark" || (mode === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);

  return null;
}
