// Shared by the three live vision callers. Keep legacy model overrides usable
// without sending reasoning parameters to the non-reasoning GPT-4.1 family.
export const DEFAULT_VISION_MODEL = 'gpt-5.6-luna';

export function defaultVisionReasoningEffort(model) {
  if (model === 'gpt-5.6-luna') return 'none';
  if (model === 'gpt-5.6-sol') return 'medium';
  return '';
}

export function visionModelOptions(model = DEFAULT_VISION_MODEL, reasoningEffort = defaultVisionReasoningEffort(model)) {
  return { model, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) };
}
