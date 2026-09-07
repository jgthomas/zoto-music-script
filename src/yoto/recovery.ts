import type { UploadJobStore } from "./job-store.ts";

export async function checkUploadRecovery(options: {
  jobStore?: UploadJobStore;
  jobKey?: string;
  retryCreate?: boolean;
}): Promise<void> {
  if (options.retryCreate && (!options.jobStore || !options.jobKey)) {
    throw new Error("--retry-create requires a saved job");
  }
  if (!options.jobStore || !options.jobKey) return;
  const job = await options.jobStore.get(options.jobKey);
  if (job?.creating && !job.cardId && !options.retryCreate) {
    throw new Error(
      "The previous Yoto playlist creation outcome is unknown. Check your Yoto library. " +
        "Only if no playlist exists, rerun with --retry-create. --restart does not clear this warning.",
    );
  }
}
