// File names from draft titles, the same way as scratchpad_core::export's
// file_stem, so a single exported draft is named like it is in Export All.

const RESERVED = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'LPT1', 'LPT2', 'LPT3'];
const MAX_STEM = 80;

/** A title made safe as a file name: no separators, reserved or control characters, no leading dots. */
export function fileStem(title: string): string {
  const cleaned = title.replace(/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ');
  let stem = [...cleaned.replace(/^[. ]+|[. ]+$/g, '')].slice(0, MAX_STEM).join('').replace(/[. ]+$/, '');
  if (RESERVED.includes(stem.toUpperCase())) stem += '_';
  return stem && title !== 'New draft' ? stem : 'Untitled';
}
