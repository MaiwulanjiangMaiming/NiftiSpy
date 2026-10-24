/**
 * Webview entry point for the shared NIfTI header parser. The implementation
 * (and the NiiHeader type) lives in src/nifti/headerParser.ts so the extension
 * host and the webview can never drift apart again.
 */
export {
  DATATYPE_MAP,
  DATATYPE_NAMES,
  parseNiiHeader,
  type NiiDataType,
  type NiiHeader,
  type NiiOrientation,
} from '../src/nifti/headerParser';
