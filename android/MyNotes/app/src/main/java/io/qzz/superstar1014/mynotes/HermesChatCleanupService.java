package io.qzz.superstar1014.mynotes;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Runs app-private Hermes history and encrypted image cleanup once per day. */
public final class HermesChatCleanupService extends JobService {
  private static final int JOB_ID = 0x4845524D;
  private static final long CLEANUP_INTERVAL_MILLIS = 24L * 60 * 60 * 1000;

  private ExecutorService executor;

  static void schedule(Context context) {
    JobScheduler scheduler = context.getSystemService(JobScheduler.class);
    if (scheduler == null || scheduler.getPendingJob(JOB_ID) != null) return;
    JobInfo job = new JobInfo.Builder(
      JOB_ID,
      new ComponentName(context, HermesChatCleanupService.class)
    )
      .setPeriodic(CLEANUP_INTERVAL_MILLIS)
      .setPersisted(true)
      .build();
    scheduler.schedule(job);
  }

  @Override
  public boolean onStartJob(JobParameters parameters) {
    executor = Executors.newSingleThreadExecutor();
    executor.submit(() -> {
      try {
        cleanAllProfiles(getApplicationContext());
      } finally {
        if (executor != null) executor.shutdown();
        jobFinished(parameters, false);
      }
    });
    return true;
  }

  @Override
  public boolean onStopJob(JobParameters parameters) {
    if (executor != null) executor.shutdownNow();
    return true;
  }

  static void cleanAllProfiles(Context context) {
    int retentionDays = HermesChatCacheSettings.retentionDays(context);
    if (retentionDays <= 0) return;
    SecureSessionStore secureStore = new SecureSessionStore(context);
    long now = System.currentTimeMillis();
    for (String spaceId : secureStore.hermesChatSpaceIds()) {
      String encodedKey = secureStore.loadHermesChatKey(spaceId);
      if (encodedKey.isEmpty()) continue;
      try {
        HermesChatCrypto crypto = new HermesChatCrypto(encodedKey);
        HermesChatHistoryStore history = new HermesChatHistoryStore(context, spaceId, crypto);
        HermesChatHistoryStore.Snapshot snapshot = history.loadAndCleanup(
          retentionDays,
          now
        );
        new HermesChatImageCache(context, spaceId).retain(snapshot.messages);
      } catch (Exception ignored) {
        // One damaged profile must not prevent cleanup of other isolated profiles.
      }
    }
  }
}
