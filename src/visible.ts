import { escapeUnicode } from "escape-unicode";

/**
 * Text written by agents as a person's terminal shows it: C0 and C1 control
 * characters other than a newline and a tab are visible escapes (ESC as
 * \u001b), so board's data never drives the terminal (decision 28).
 */
export function shown(text: string): string {
	return escapeUnicode(text, { filter: isControl });
}

/**
 * The same for a field of a line that must stay one line, such as a field
 * of `board watch`'s tab-separated line: a newline or a tab in it is shown
 * too, so the data cannot forge a line or a column.
 */
export function oneLine(text: string): string {
	return escapeUnicode(text, {
		filter: (code) => code < 0x20 || isControl(code),
	});
}

function isControl(code: number): boolean {
	return (
		(code < 0x20 && code !== 0x0a && code !== 0x09) ||
		(code >= 0x80 && code <= 0x9f)
	);
}
