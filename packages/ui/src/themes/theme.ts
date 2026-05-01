/**
 * @sweech/ui — ThemeProvider + createTheme
 *
 * Usage:
 *   import { ThemeProvider } from '@sweech/ui'
 *   import '@sweech/ui/themes/jobforge.css'   // or keel.css, etc.
 *
 *   <ThemeProvider theme="jobforge">
 *     <ChatThread ... />
 *   </ThemeProvider>
 *
 * Or with custom token overrides:
 *   const myTheme = createTheme('jobforge', { accent: '#ff0066' })
 *   <ThemeProvider theme={myTheme}>...</ThemeProvider>
 */

import React from 'react'

export interface SweechTheme {
  /** The product id — sets data-sweech-product attribute. */
  product: string
  /** Optional colour mode. Defaults to 'dark'. */
  colorScheme?: 'dark' | 'light'
  /** Token overrides — any --sweech-* variable without the prefix. */
  tokens?: Record<string, string>
}

/** @deprecated Use SweechTheme */
export type OmnaiTheme = SweechTheme

export interface ThemeProviderProps {
  theme: string | SweechTheme
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

/**
 * Creates a SweechTheme object with optional token overrides.
 * Pass the result to ThemeProvider.
 */
export function createTheme(
  product: string,
  overrides: { colorScheme?: 'dark' | 'light'; tokens?: Record<string, string> } = {}
): SweechTheme {
  return { product, ...overrides }
}

/**
 * Wraps children in a scoped theme container.
 * Sets data-sweech-product (and optionally data-theme) on the wrapper div,
 * then injects any token overrides as inline CSS variables.
 */
export function ThemeProvider({ theme, children, className, style }: ThemeProviderProps) {
  const resolved: SweechTheme =
    typeof theme === 'string' ? { product: theme } : theme

  const { product, colorScheme, tokens } = resolved

  const inlineVars: Record<string, string> = {}
  if (tokens) {
    for (const [key, value] of Object.entries(tokens)) {
      const varName = key.startsWith('--') ? key : `--sweech-${key}`
      inlineVars[varName] = value
    }
  }

  return React.createElement('div', {
    'data-sweech-product': product,
    ...(colorScheme ? { 'data-theme': colorScheme } : {}),
    className,
    style: { ...inlineVars, ...style } as React.CSSProperties,
    children,
  })
}

/** Built-in theme presets. */
export const themes = {
  jobforge: createTheme('jobforge'),
  keel: createTheme('keel'),
} satisfies Record<string, SweechTheme>
