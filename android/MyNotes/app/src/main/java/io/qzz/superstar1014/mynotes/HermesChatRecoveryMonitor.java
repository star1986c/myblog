package io.qzz.superstar1014.mynotes;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.os.Handler;

/** Process-lifetime callbacks only; no polling, alarms, wake locks or activity references. */
final class HermesChatRecoveryMonitor {
  interface Listener {
    void onForeground();
    void onNetworkChanged(boolean available);
  }

  private final ConnectivityManager connectivity;
  private final Listener listener;
  private Network network;
  private boolean available;

  HermesChatRecoveryMonitor(Context context, Handler handler, Listener listener) {
    this.listener = listener;
    connectivity = context.getSystemService(ConnectivityManager.class);
    refreshNetwork(false);
    connectivity.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
      @Override public void onAvailable(Network network) { refreshNetwork(true); }
      @Override public void onLost(Network network) { refreshNetwork(true); }
      @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
        refreshNetwork(true);
      }
    }, handler);
    ((Application) context).registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
      @Override public void onActivityResumed(Activity activity) {
        refreshNetwork(true);
        listener.onForeground();
      }
      @Override public void onActivityCreated(Activity activity, Bundle state) {}
      @Override public void onActivityStarted(Activity activity) {}
      @Override public void onActivityPaused(Activity activity) {}
      @Override public void onActivityStopped(Activity activity) {}
      @Override public void onActivitySaveInstanceState(Activity activity, Bundle state) {}
      @Override public void onActivityDestroyed(Activity activity) {}
    });
  }

  boolean isNetworkAvailable() { return available; }

  private void refreshNetwork(boolean notify) {
    Network current = connectivity.getActiveNetwork();
    NetworkCapabilities caps = connectivity.getNetworkCapabilities(current);
    boolean usable = caps != null
      && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    boolean changed = available != usable || (usable && !current.equals(network));
    network = current;
    available = usable;
    if (notify && changed) listener.onNetworkChanged(usable);
  }
}
