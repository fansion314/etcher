import * as React from 'react';
import { host } from './bridge';
// External content is opened in the user's browser, never in a window that has
// disk-operation bindings. Dnr has no equivalent to Electron's isolated webview.
export function SafeWebview({ src, style }: {src: string; style?: React.CSSProperties; onWebviewShow?: (v: boolean) => void}) {
  return <div style={{...style, textAlign: 'center', padding: 12}}>
    <a href={src} onClick={event => { event.preventDefault(); host('openExternal', src).catch(console.error); }}>Explore balena</a>
  </div>;
}
