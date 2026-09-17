/** Escape dla HTML wpinanego do popupów Leaflet (bindPopup przyjmuje surowy HTML). */
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** „+48 184 422 211" → „+48184422211" — bezpieczny href tel: (bez znaków łamiących atrybut HTML). */
export function telHref(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}
