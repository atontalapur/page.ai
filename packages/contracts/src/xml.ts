// The one string helper here: the pager's TwiML and the eval's SVG charts both put free text
// into XML, and both need the same escaping.

/** Escapes text for an XML text node or a quoted attribute value. */
export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
