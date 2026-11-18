/** A missing installed face is an input dependency failure, not a GPU failure. */
export const CAPTION_FONT_MISSING='caption-font-missing' as const;
export function missingCaptionFont(message:string):Error&{code:typeof CAPTION_FONT_MISSING}{
  return Object.assign(new Error(message),{name:'CaptionFontError',code:CAPTION_FONT_MISSING});
}
export function isMissingCaptionFont(error:unknown):boolean{
  return error instanceof Error&&(error as Error&{code?:unknown}).code===CAPTION_FONT_MISSING;
}
