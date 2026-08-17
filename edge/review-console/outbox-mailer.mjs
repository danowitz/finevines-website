export function createOutboxMailer(state) {
  if (!state?.enqueueNotification) throw new Error('outbox mailer requires review state');
  return {
    send: async (message) => {
      if (!message?.dedupeKey) throw new Error('outbox email requires a dedupe key');
      await state.enqueueNotification(message);
    },
  };
}
