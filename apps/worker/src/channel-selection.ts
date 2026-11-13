export type ChannelChoice = "VIBER" | "SMS" | "NONE";

export interface ChannelSelectionInput {
  suppressed: boolean;
  viberAvailable: boolean | null; // true = verified on Viber, false = verified not on Viber, null = unknown
  viberBasisValid: boolean;
  smsBasisValid: boolean;
  hasUncertainViberAttempt: boolean;
}

export function selectMessageChannel(input: ChannelSelectionInput): ChannelChoice {
  if (input.suppressed || input.hasUncertainViberAttempt) {
    return "NONE";
  }
  if (input.viberAvailable === true && input.viberBasisValid) {
    return "VIBER";
  }
  if (input.viberAvailable === false && input.smsBasisValid) {
    return "SMS";
  }
  if (input.viberAvailable === null && !input.viberBasisValid && input.smsBasisValid) {
    return "SMS";
  }
  return "NONE";
}
