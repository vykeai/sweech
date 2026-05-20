import React, { createContext, useContext } from 'react';

export type VysualTheme = {
  name: string;
  colors: {
    background: string;
    surface: string;
    surfaceStrong: string;
    border: string;
    text: string;
    muted: string;
    accent: string;
    success: string;
    warning: string;
    danger: string;
  };
};

export const themes = {
  sweech: {
    name: 'sweech',
    colors: {
      background: '#f7f8fb',
      surface: '#ffffff',
      surfaceStrong: '#eef2f8',
      border: '#d9e0ea',
      text: '#152033',
      muted: '#627089',
      accent: '#0f766e',
      success: '#16834a',
      warning: '#b45309',
      danger: '#b42318',
    },
  },
} satisfies Record<string, VysualTheme>;

const ThemeContext = createContext<VysualTheme>(themes.sweech);

export function ThemeProvider({ theme, children }: { theme: VysualTheme; children: React.ReactNode }) {
  const vars = {
    '--vysual-bg': theme.colors.background,
    '--vysual-surface': theme.colors.surface,
    '--vysual-surface-strong': theme.colors.surfaceStrong,
    '--vysual-border': theme.colors.border,
    '--vysual-text': theme.colors.text,
    '--vysual-muted': theme.colors.muted,
    '--vysual-accent': theme.colors.accent,
    '--vysual-success': theme.colors.success,
    '--vysual-warning': theme.colors.warning,
    '--vysual-danger': theme.colors.danger,
  } as React.CSSProperties;

  return (
    <ThemeContext.Provider value={theme}>
      <div data-vysual-theme={theme.name} style={vars}>{children}</div>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function Card({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return <section className={`vysual-card ${className}`.trim()}>{children}</section>;
}
