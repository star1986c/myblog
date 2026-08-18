package io.qzz.superstar1014.mynotes;

import android.app.Activity;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Telegram-inspired, configuration-driven entry point for isolated Hermes chats. */
public final class HermesConversationsActivity extends Activity
    implements HermesChatConnectionManager.UnreadListener {
  private static final DateTimeFormatter TIME_FORMATTER = DateTimeFormatter.ofPattern(
    "HH:mm",
    Locale.ROOT
  );
  private static final DateTimeFormatter DATE_FORMATTER = DateTimeFormatter.ofPattern(
    "MM-dd",
    Locale.ROOT
  );

  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final List<Models.HermesChatProfile> profiles = new ArrayList<>();
  private final Map<String, ConversationSummary> summaries = new HashMap<>();

  private NotesApiClient api;
  private SecureSessionStore secureStore;
  private HermesChatProfileStore profileStore;
  private HermesChatConnectionManager connection;
  private LinearLayout profileList;
  private TextView profileCount;
  private boolean demoMode;
  private boolean destroyed;
  private boolean firstResume = true;
  private long loadGeneration;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().setNavigationBarContrastEnforced(false);
    demoMode = (getApplicationInfo().flags
      & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
      && getIntent().getBooleanExtra("demo", false);
    api = new NotesApiClient(this);
    secureStore = new SecureSessionStore(this);
    profileStore = new HermesChatProfileStore(this);
    connection = HermesChatConnectionManager.get(this);
    connection.addUnreadListener(this);
    buildScreen();
    if (demoMode) loadDemoProfiles();
    else loadCachedProfiles();
  }

  @Override
  protected void onResume() {
    super.onResume();
    if (demoMode) return;
    if (firstResume) {
      firstResume = false;
      return;
    }
    if (!profiles.isEmpty()) loadLocalSummaries();
  }

  @Override
  protected void onDestroy() {
    destroyed = true;
    loadGeneration += 1;
    if (connection != null) connection.removeUnreadListener(this);
    executor.shutdownNow();
    super.onDestroy();
  }

  private void buildScreen() {
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(getColor(R.color.background));
    LinearLayout column = vertical();
    root.addView(column, new FrameLayout.LayoutParams(-1, -1));

    LinearLayout top = horizontal(Gravity.CENTER_VERTICAL);
    top.setPadding(dp(8), dp(8), dp(8), dp(6));
    top.setBackgroundColor(getColor(R.color.surface));
    ImageButton back = iconButton(R.drawable.ic_arrow_back, "返回笔记");
    back.setOnClickListener(view -> finish());
    top.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));

    LinearLayout heading = vertical();
    TextView title = text("Hermes 会话", 21, R.color.text_primary);
    title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    heading.addView(title, new LinearLayout.LayoutParams(-1, dp(28)));
    profileCount = text("正在同步聊天对象…", 12, R.color.text_secondary);
    heading.addView(profileCount, new LinearLayout.LayoutParams(-1, dp(20)));
    LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(0, dp(52), 1);
    headingParams.setMarginStart(dp(8));
    top.addView(heading, headingParams);

    ImageButton refresh = iconButton(R.drawable.ic_refresh, "刷新聊天对象");
    refresh.setOnClickListener(view -> loadProfilesFromServer());
    top.addView(refresh, new LinearLayout.LayoutParams(dp(48), dp(48)));
    column.addView(top, new LinearLayout.LayoutParams(-1, dp(66)));

    LinearLayout security = horizontal(Gravity.CENTER_VERTICAL);
    security.setPadding(dp(14), dp(8), dp(14), dp(8));
    security.setBackground(rounded(R.color.surface_tonal, 16));
    ImageView lock = new ImageView(this);
    lock.setImageResource(R.drawable.ic_lock);
    lock.setImageTintList(ColorStateList.valueOf(getColor(R.color.brand_primary_dark)));
    lock.setContentDescription(null);
    security.addView(lock, new LinearLayout.LayoutParams(dp(24), dp(24)));
    TextView securityText = text(
      "每个聊天对象使用独立密钥与本机加密缓存",
      13,
      R.color.text_primary
    );
    LinearLayout.LayoutParams securityTextParams = new LinearLayout.LayoutParams(0, -2, 1);
    securityTextParams.setMarginStart(dp(10));
    security.addView(securityText, securityTextParams);
    LinearLayout.LayoutParams securityParams = new LinearLayout.LayoutParams(-1, -2);
    securityParams.setMargins(dp(14), 0, dp(14), dp(10));
    column.addView(security, securityParams);

    TextView section = text("所有聊天", 13, R.color.text_secondary);
    section.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    section.setPadding(dp(18), dp(8), dp(18), dp(6));
    column.addView(section, new LinearLayout.LayoutParams(-1, dp(38)));

    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.setBackgroundColor(getColor(R.color.surface));
    profileList = vertical();
    profileList.setPadding(0, dp(4), 0, dp(16));
    scroll.addView(profileList, new ScrollView.LayoutParams(-1, -2));
    column.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

    setContentView(applyInsets(root));
  }

  private void loadCachedProfiles() {
    List<Models.HermesChatProfile> cachedProfiles = profileStore.load();
    if (cachedProfiles.isEmpty()) {
      loadProfilesFromServer();
      return;
    }
    applyProfiles(cachedProfiles, true);
  }

  private void loadProfilesFromServer() {
    long generation = ++loadGeneration;
    profileCount.setText("正在同步聊天对象…");
    executor.submit(() -> {
      try {
        NotesApiClient.SessionResult session = api.restoreSession();
        if (!session.authenticated) throw new IllegalStateException("请先在 My Notes 登录。");
        List<Models.HermesChatProfile> loadedProfiles = api.hermesChatProfiles();
        profileStore.save(loadedProfiles);
        Map<String, ConversationSummary> loadedSummaries = loadSummaries(loadedProfiles);
        runOnUiThread(() -> {
          if (destroyed || generation != loadGeneration) return;
          profiles.clear();
          profiles.addAll(loadedProfiles);
          summaries.clear();
          summaries.putAll(loadedSummaries);
          profileCount.setText(profiles.size() + " 个聊天对象 · 端到端加密");
          connection.syncProfiles(profiles);
          HermesChatConnectionService.startIfConfigured(this);
          renderProfiles();
        });
      } catch (Exception error) {
        runOnUiThread(() -> {
          if (destroyed || generation != loadGeneration) return;
          if (profiles.isEmpty()) {
            profileCount.setText("聊天对象加载失败 · 点右侧重试");
            showListMessage("无法加载 Hermes 会话\n" + safeMessage(error));
          } else {
            profileCount.setText(profiles.size() + " 个聊天对象 · 本地缓存（刷新失败）");
            renderProfiles();
          }
        });
      }
    });
  }

  private void applyProfiles(List<Models.HermesChatProfile> loadedProfiles, boolean cached) {
    long generation = ++loadGeneration;
    profiles.clear();
    profiles.addAll(loadedProfiles);
    profileCount.setText(
      profiles.size() + " 个聊天对象 · " + (cached ? "本地缓存" : "端到端加密")
    );
    connection.syncProfiles(profiles);
    HermesChatConnectionService.startIfConfigured(this);
    renderProfiles();
    executor.submit(() -> {
      Map<String, ConversationSummary> loadedSummaries = loadSummaries(loadedProfiles);
      runOnUiThread(() -> {
        if (destroyed || generation != loadGeneration) return;
        summaries.clear();
        summaries.putAll(loadedSummaries);
        renderProfiles();
      });
    });
  }

  @Override
  public void onUnreadChanged(String profileId, int unreadCount) {
    runOnUiThread(() -> {
      if (!destroyed) renderProfiles();
    });
  }

  private void loadDemoProfiles() {
    long now = System.currentTimeMillis();
    profiles.clear();
    profiles.add(new Models.HermesChatProfile("primary", "Hermes 主助手"));
    profiles.add(new Models.HermesChatProfile("personal", "Hermes 个人助手"));
    summaries.clear();
    summaries.put("primary", new ConversationSummary("已整理今天的笔记与待办。", now - 240_000, true));
    summaries.put("personal", new ConversationSummary("Gateway online — Hermes is ready.", now - 60_000, true));
    profileCount.setText(profiles.size() + " 个聊天对象 · 端到端加密");
    renderProfiles();
  }

  private void loadLocalSummaries() {
    long generation = ++loadGeneration;
    List<Models.HermesChatProfile> currentProfiles = new ArrayList<>(profiles);
    executor.submit(() -> {
      Map<String, ConversationSummary> loadedSummaries = loadSummaries(currentProfiles);
      runOnUiThread(() -> {
        if (destroyed || generation != loadGeneration) return;
        summaries.clear();
        summaries.putAll(loadedSummaries);
        renderProfiles();
      });
    });
  }

  private Map<String, ConversationSummary> loadSummaries(
    List<Models.HermesChatProfile> targetProfiles
  ) {
    Map<String, ConversationSummary> result = new HashMap<>();
    for (Models.HermesChatProfile profile : targetProfiles) {
      result.put(profile.id, localSummary(profile));
    }
    return result;
  }

  private ConversationSummary localSummary(Models.HermesChatProfile profile) {
    String key = secureStore.loadHermesChatKey(profile.id);
    if (key.isEmpty()) return new ConversationSummary("尚未设置聊天密钥", 0, false);
    try {
      HermesChatCrypto profileCrypto = new HermesChatCrypto(key);
      HermesChatHistoryStore history = new HermesChatHistoryStore(this, profile.id, profileCrypto);
      HermesChatHistoryStore.Snapshot snapshot = history.loadAndCleanup(
        HermesChatCacheSettings.retentionDays(this),
        System.currentTimeMillis()
      );
      if (snapshot.messages.isEmpty()) {
        return new ConversationSummary("密钥已配置 · 暂无本地消息", 0, true);
      }
      HermesChatCrypto.ChatMessage last = snapshot.messages.get(snapshot.messages.size() - 1);
      String preview = last.text == null ? "" : last.text.replaceAll("\\s+", " ").trim();
      if (preview.isEmpty() && last.attachments.length() > 0) {
        preview = attachmentPreview(last.attachments.optJSONObject(0));
      }
      if (preview.isEmpty()) preview = "加密消息";
      if (preview.length() > 64) preview = preview.substring(0, 64) + "…";
      if ("client".equals(last.sender)) preview = "你：" + preview;
      return new ConversationSummary(preview, last.sentAt, true);
    } catch (Exception error) {
      return new ConversationSummary("聊天密钥需要重新设置", 0, false);
    }
  }

  private void renderProfiles() {
    if (profileList == null) return;
    profileList.removeAllViews();
    for (Models.HermesChatProfile profile : profiles) {
      addProfileRow(profile, summaries.get(profile.id));
    }
    if (profiles.isEmpty()) showListMessage("尚未配置 Hermes profile");
  }

  private static String attachmentPreview(JSONObject descriptor) {
    if (descriptor == null) return "加密附件";
    String name = descriptor.optString("name", "");
    String contentType = descriptor.optString("contentType", "application/octet-stream");
    try {
      HermesChatAttachmentPolicy.ResolvedType type = HermesChatAttachmentPolicy.resolve(
        contentType,
        name
      );
      String safeName = HermesChatAttachmentPolicy.safeDisplayName(name, type);
      return type.category.label + "：" + safeName;
    } catch (IllegalArgumentException ignored) {
      return "加密附件";
    }
  }

  private void addProfileRow(
    Models.HermesChatProfile profile,
    ConversationSummary summary
  ) {
    if (summary == null) summary = new ConversationSummary("正在读取本机加密缓存…", 0, false);
    LinearLayout row = horizontal(Gravity.CENTER_VERTICAL);
    row.setPadding(dp(14), dp(8), dp(12), dp(8));
    row.setMinimumHeight(dp(82));
    row.setBackground(ripple(R.color.surface, 0));
    row.setClickable(true);
    row.setFocusable(true);
    row.setContentDescription(profile.label + "，" + summary.preview);
    row.setOnClickListener(view -> openConversation(profile));

    FrameLayout avatar = new FrameLayout(this);
    avatar.setBackground(oval(R.color.surface_tonal));
    ImageView avatarIcon = new ImageView(this);
    avatarIcon.setImageResource(R.drawable.ic_chat);
    avatarIcon.setImageTintList(ColorStateList.valueOf(getColor(R.color.brand_primary_dark)));
    avatarIcon.setContentDescription(null);
    avatarIcon.setPadding(dp(13), dp(13), dp(13), dp(13));
    avatar.addView(avatarIcon, new FrameLayout.LayoutParams(-1, -1));
    row.addView(avatar, new LinearLayout.LayoutParams(dp(54), dp(54)));

    LinearLayout content = vertical();
    TextView name = text(profile.label, 17, R.color.text_primary);
    name.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    name.setSingleLine(true);
    name.setEllipsize(TextUtils.TruncateAt.END);
    content.addView(name, new LinearLayout.LayoutParams(-1, dp(26)));
    TextView preview = text(summary.preview, 14, R.color.text_secondary);
    preview.setSingleLine(true);
    preview.setEllipsize(TextUtils.TruncateAt.END);
    content.addView(preview, new LinearLayout.LayoutParams(-1, dp(24)));
    LinearLayout.LayoutParams contentParams = new LinearLayout.LayoutParams(0, dp(54), 1);
    contentParams.setMargins(dp(12), 0, dp(8), 0);
    row.addView(content, contentParams);

    LinearLayout trailing = vertical();
    trailing.setGravity(Gravity.END);
    TextView time = text(formatSummaryTime(summary.sentAt), 12, R.color.text_secondary);
    time.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
    trailing.addView(time, new LinearLayout.LayoutParams(dp(72), dp(25)));
    int unreadCount = connection.unreadCount(profile.id);
    if (unreadCount > 0) {
      TextView badge = text(unreadCount > 99 ? "99+" : String.valueOf(unreadCount), 11,
        R.color.on_brand);
      badge.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
      badge.setGravity(Gravity.CENTER);
      badge.setBackground(oval(R.color.brand_primary));
      badge.setContentDescription(unreadCount + " 条未读消息");
      LinearLayout.LayoutParams badgeParams = new LinearLayout.LayoutParams(
        unreadCount > 99 ? dp(38) : dp(26),
        dp(24)
      );
      badgeParams.gravity = Gravity.END;
      trailing.addView(badge, badgeParams);
    } else {
      TextView keyState = text(summary.keyConfigured ? "已加密" : "需密钥", 12,
        summary.keyConfigured ? R.color.brand_primary_dark : R.color.warning);
      keyState.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
      trailing.addView(keyState, new LinearLayout.LayoutParams(dp(72), dp(25)));
    }
    row.addView(trailing, new LinearLayout.LayoutParams(dp(72), dp(54)));

    profileList.addView(row, new LinearLayout.LayoutParams(-1, dp(82)));
    View divider = new View(this);
    divider.setBackgroundColor(getColor(R.color.divider));
    LinearLayout.LayoutParams dividerParams = new LinearLayout.LayoutParams(-1, dp(1));
    dividerParams.setMarginStart(dp(80));
    profileList.addView(divider, dividerParams);
  }

  private void showListMessage(String value) {
    if (profileList == null) return;
    profileList.removeAllViews();
    TextView empty = text(value, 15, R.color.text_secondary);
    empty.setGravity(Gravity.CENTER);
    empty.setPadding(dp(28), dp(48), dp(28), dp(48));
    profileList.addView(empty, new LinearLayout.LayoutParams(-1, -2));
  }

  private void openConversation(Models.HermesChatProfile profile) {
    Intent intent = new Intent(this, HermesChatActivity.class);
    intent.putExtra(HermesChatActivity.EXTRA_PROFILE_ID, profile.id);
    intent.putExtra(HermesChatActivity.EXTRA_PROFILE_LABEL, profile.label);
    intent.putExtra("demo", demoMode);
    if (demoMode) {
      intent.putExtra(
        HermesChatActivity.EXTRA_DEMO_AWAITING,
        getIntent().getBooleanExtra(HermesChatActivity.EXTRA_DEMO_AWAITING, false)
      );
    }
    startActivity(intent);
  }

  private String formatSummaryTime(long sentAt) {
    if (sentAt <= 0) return "";
    ZoneId zone = ZoneId.systemDefault();
    java.time.ZonedDateTime value = Instant.ofEpochMilli(sentAt).atZone(zone);
    if (LocalDate.now(zone).equals(value.toLocalDate())) return TIME_FORMATTER.format(value);
    return DATE_FORMATTER.format(value);
  }

  private static String safeMessage(Exception error) {
    String value = error.getMessage();
    return value == null || value.trim().isEmpty() ? "操作失败。" : value;
  }

  private <T extends View> T applyInsets(T view) {
    int left = view.getPaddingLeft();
    int top = view.getPaddingTop();
    int right = view.getPaddingRight();
    int bottom = view.getPaddingBottom();
    view.setOnApplyWindowInsetsListener((target, insets) -> {
      android.graphics.Insets bars = insets.getInsets(
        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
      );
      android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
      target.setPadding(
        left + bars.left,
        top + bars.top,
        right + bars.right,
        bottom + Math.max(bars.bottom, ime.bottom)
      );
      return insets;
    });
    view.requestApplyInsets();
    return view;
  }

  private LinearLayout vertical() {
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    return layout;
  }

  private LinearLayout horizontal(int gravity) {
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.HORIZONTAL);
    layout.setGravity(gravity);
    return layout;
  }

  private TextView text(String value, float size, int color) {
    TextView view = new TextView(this);
    view.setText(value);
    view.setTextSize(size);
    view.setTextColor(getColor(color));
    view.setGravity(Gravity.CENTER_VERTICAL);
    view.setIncludeFontPadding(false);
    return view;
  }

  private ImageButton iconButton(int drawable, String description) {
    ImageButton button = new ImageButton(this);
    button.setImageResource(drawable);
    button.setImageTintList(ColorStateList.valueOf(getColor(R.color.brand_primary_dark)));
    button.setContentDescription(description);
    button.setPadding(dp(12), dp(12), dp(12), dp(12));
    button.setBackground(ripple(R.color.surface, 16));
    return button;
  }

  private GradientDrawable rounded(int color, int radius) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setColor(getColor(color));
    drawable.setCornerRadius(dp(radius));
    return drawable;
  }

  private GradientDrawable roundedStroke(int color, int strokeColor, int radius, int strokeWidth) {
    GradientDrawable drawable = rounded(color, radius);
    drawable.setStroke(dp(strokeWidth), getColor(strokeColor));
    return drawable;
  }

  private GradientDrawable oval(int color) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setShape(GradientDrawable.OVAL);
    drawable.setColor(getColor(color));
    return drawable;
  }

  private RippleDrawable ripple(int color, int radius) {
    GradientDrawable content = rounded(color, radius);
    GradientDrawable mask = rounded(android.R.color.white, radius);
    return new RippleDrawable(
      ColorStateList.valueOf(getColor(R.color.surface_high)),
      content,
      mask
    );
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private static final class ConversationSummary {
    final String preview;
    final long sentAt;
    final boolean keyConfigured;

    ConversationSummary(String preview, long sentAt, boolean keyConfigured) {
      this.preview = preview;
      this.sentAt = sentAt;
      this.keyConfigured = keyConfigured;
    }
  }
}
