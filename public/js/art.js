// Hand-drawn SVG decorations (no external images).
import { raw } from './lib.js';

export const hat = raw(`<svg viewBox="0 0 64 64" aria-hidden="true">
  <path d="M10 46 C 14 24, 32 8, 52 14 C 45 20, 42 30, 46 46 Z" fill="#e8253f"/>
  <path d="M22 44 C 26 30, 36 20, 48 17" stroke="#fff" stroke-opacity=".25" stroke-width="3" fill="none" stroke-linecap="round"/>
  <circle cx="52" cy="14" r="7" fill="#fff"/>
  <rect x="6" y="42" width="46" height="13" rx="6.5" fill="#fff"/>
</svg>`);

// The login scene: a tree with baubles, a star and a pile of presents.
export const tree = raw(`<svg viewBox="0 0 420 380" role="img" aria-label="A Christmas tree with presents underneath">
  <defs>
    <linearGradient id="tg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#1f9a55"/><stop offset="1" stop-color="#0f5a31"/></linearGradient>
    <radialGradient id="glow"><stop offset="0" stop-color="#ffe9a8" stop-opacity=".9"/><stop offset="1" stop-color="#ffe9a8" stop-opacity="0"/></radialGradient>
  </defs>
  <ellipse cx="210" cy="352" rx="170" ry="16" fill="#000" opacity=".08"/>
  <circle cx="210" cy="40" r="46" fill="url(#glow)"/>
  <rect x="196" y="292" width="28" height="46" rx="4" fill="#7a4a24"/>
  <path d="M210 52 L300 160 L262 160 L330 238 L288 238 L352 304 L68 304 L132 238 L90 238 L158 160 L120 160 Z" fill="url(#tg)"/>
  <path d="M132 238 Q 210 266 288 238" stroke="#f2b632" stroke-width="5" fill="none" stroke-linecap="round"/>
  <path d="M158 160 Q 210 186 262 160" stroke="#f2b632" stroke-width="5" fill="none" stroke-linecap="round"/>
  <path d="M100 300 Q 210 330 320 300" stroke="#f2b632" stroke-width="5" fill="none" stroke-linecap="round" opacity=".0"/>
  <g>
    <circle cx="180" cy="130" r="9" fill="#e8253f"/><circle cx="242" cy="142" r="8" fill="#f2b632"/>
    <circle cx="160" cy="212" r="10" fill="#4aa3df"/><circle cx="230" cy="206" r="9" fill="#e8253f"/>
    <circle cx="270" cy="220" r="8" fill="#fff"/><circle cx="130" cy="280" r="10" fill="#f2b632"/>
    <circle cx="200" cy="268" r="10" fill="#fff"/><circle cx="262" cy="282" r="11" fill="#e8253f"/>
    <circle cx="312" cy="290" r="8" fill="#4aa3df"/><circle cx="104" cy="296" r="7" fill="#e8253f"/>
    <circle cx="177" cy="127" r="3" fill="#fff" opacity=".6"/><circle cx="157" cy="208" r="3" fill="#fff" opacity=".6"/>
    <circle cx="259" cy="278" r="3.5" fill="#fff" opacity=".6"/>
  </g>
  <path d="M210 14 l9 20 22 2 -17 14 6 21 -20 -12 -20 12 6 -21 -17 -14 22 -2 z" fill="#f7c94b" stroke="#e0a526" stroke-width="2"/>
  <g>
    <rect x="70" y="300" width="74" height="54" rx="5" fill="#b3001b"/><rect x="101" y="300" width="12" height="54" fill="#f2b632"/>
    <rect x="70" y="318" width="74" height="10" fill="#f2b632"/>
    <path d="M107 300 C 92 284, 84 296, 104 302 M107 300 C 122 284, 130 296, 110 302" stroke="#f2b632" stroke-width="5" fill="none"/>
    <rect x="262" y="310" width="66" height="44" rx="5" fill="#146b3a"/><rect x="289" y="310" width="11" height="44" fill="#fff"/>
    <rect x="262" y="326" width="66" height="9" fill="#fff"/>
    <rect x="160" y="324" width="56" height="30" rx="4" fill="#4aa3df"/><rect x="183" y="324" width="9" height="30" fill="#fff"/>
    <rect x="326" y="328" width="40" height="26" rx="4" fill="#f2b632"/><rect x="342" y="328" width="8" height="26" fill="#b3001b"/>
  </g>
  <g fill="#fff" opacity=".9">
    <circle cx="40" cy="60" r="3"/><circle cx="380" cy="90" r="2.5"/><circle cx="70" cy="150" r="2"/><circle cx="350" cy="190" r="3"/>
    <circle cx="30" cy="230" r="2"/><circle cx="395" cy="250" r="2"/><circle cx="110" cy="40" r="2"/><circle cx="320" cy="30" r="2.5"/>
  </g>
</svg>`);

export const msLogo = raw('<span class="ms-logo" aria-hidden="true"><i style="background:#f25022"></i><i style="background:#7fba00"></i><i style="background:#00a4ef"></i><i style="background:#ffb900"></i></span>');
