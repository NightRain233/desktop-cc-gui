/**
 * Chat content column width (设置 → 通用 → 外观 → 宽幕布).
 *
 * Every surface that shares the conversation's center track — the message
 * timeline, composer, run status, attachment chips, message queue and the
 * question / plan docks — centers itself on one track, so a wide window keeps
 * a readable line length at the cost of two blank bands. The timeline and the
 * composer surfaces share one cap (`max-w-3xl`, 768px) so message edges line
 * up with the composer card; they used to differ (750px vs 768px).
 * `wideLayout` (setting 「宽幕布」, default off) drops the cap and lets the
 * track fill its pane, keeping only the 16px gutter the pane already reserves.
 */

const CHAT_COLUMN_WIDE = "mx-auto w-full";
/** One cap for the timeline and the composer track (composer, status bar,
 *  chips, queue, docks): a shared width is what keeps their edges aligned. */
const CHAT_COLUMN_NARROW = "mx-auto w-full max-w-3xl";

/** Class for the timeline's column; `wide` = setting on. */
export function timelineColumnClass(wide: boolean): string {
  return wide ? CHAT_COLUMN_WIDE : CHAT_COLUMN_NARROW;
}

/** Class for a composer-track surface; `wide` = setting on. */
export function centerColumnClass(wide: boolean): string {
  return wide ? CHAT_COLUMN_WIDE : CHAT_COLUMN_NARROW;
}
