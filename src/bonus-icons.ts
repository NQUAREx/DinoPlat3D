/** Original tiny SVG illustrations: sharp pixel edges, shared game palette. */
const shapes = [
  '<path fill="#43b52c" d="M10 7h12v22H10z"/><path fill="#73d8ff" d="M6 10h8v17H6zm12 0h8v17h-8z"/><path fill="#ff704c" d="M7 27h6v3h-2v2H9v-2H7zm12 0h6v3h-2v2h-2v-2h-2z"/>',
  '<path fill="#73d8ff" d="m16 3 11 11-11 16L5 14z"/><path fill="#fff2c3" d="M13 9h6v3h-6zm-3 6h12v3H10zm3 6h6v3h-6z"/>',
  '<path fill="#ff704c" d="M5 6h8v14h6V6h8v15l-5 7H10l-5-7z"/><path fill="#73d8ff" d="M5 6h8v6H5zm14 0h8v6h-8z"/>',
  '<path fill="#24374d" d="M3 9h26v14H3z"/><path fill="#805595" d="M5 11h9v9H5zm13 0h9v9h-9z"/><path fill="#fff2c3" d="m7 16 4-3 2 2-4 3zm13 0 4-3 2 2-4 3z"/>',
  '<path fill="#ffcf35" d="M17 2 5 19h9l-1 12 14-19h-9l3-10z"/>',
  '<path fill="#73d8ff" d="M4 8h16V4l9 8-9 8v-5H4z"/><path fill="#ff704c" d="M28 21H12v-5l-9 8 9 7v-4h16z"/>',
  '<path fill="#7be344" d="M10 6h12v22H10z"/><path fill="#24374d" d="M13 10h6v12h-6zM3 8h3v5H3zm23 0h3v5h-3zM2 18h4v6H2zm24 0h4v6h-4z"/>',
];
export const BONUS_ICON_URLS = shapes.map(shape => 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 34" shape-rendering="crispEdges">' + shape + '</svg>'
));
