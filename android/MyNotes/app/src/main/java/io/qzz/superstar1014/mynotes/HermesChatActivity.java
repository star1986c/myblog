package io.qzz.superstar1014.mynotes;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.MediaController;
import android.widget.PopupMenu;
import android.widget.SeekBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.widget.VideoView;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class HermesChatActivity extends Activity implements HermesChatConnectionManager.Listener {
  public static final String EXTRA_PROFILE_ID = "hermes_profile_id";
  public static final String EXTRA_PROFILE_LABEL = "hermes_profile_label";
  static final String EXTRA_DEMO_AWAITING = "hermes_demo_awaiting";
  private static final int REQUEST_ATTACHMENT = 2201;
  private static final int REQUEST_SAVE_ATTACHMENT = 2202;
  private static final long AWAITING_RESPONSE_TIMEOUT_MS = 120_000L;
  private static final DateTimeFormatter MESSAGE_TIME_FORMATTER = DateTimeFormatter.ofPattern(
    "yyyy-MM-dd HH:mm",
    Locale.ROOT
  );

  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final Set<String> renderedMessageIds = new HashSet<>();
  private final Map<Long, RenderedMessage> renderedMessagesBySequence = new HashMap<>();
  private final Map<String, RenderedMessage> renderedMessagesById = new HashMap<>();
  private final Set<String> selectedMessageIds = new HashSet<>();
  private final Set<File> playbackFiles = new HashSet<>();
  private final Set<Dialog> playbackDialogs = new HashSet<>();
  private final OnBackInvokedCallback backCallback = this::handleSystemBack;

  private NotesApiClient api;
  private SecureSessionStore secureStore;
  private HermesChatCrypto crypto;
  private HermesChatConnectionManager connection;
  private HermesChatConnectionManager.Listener connectionListener;
  private HermesChatHistoryStore historyStore;
  private HermesChatImageCache imageCache;
  private LinearLayout messages;
  private ScrollView messageScroll;
  private TextView chatTitle;
  private TextView status;
  private LinearLayout normalHeader;
  private LinearLayout selectionHeader;
  private TextView selectionCount;
  private EditText composer;
  private Button sendButton;
  private LinearLayout commandSuggestions;
  private Dialog commandPaletteDialog;
  private String suppressedCommandSuggestionText;
  private LinearLayout pendingAttachmentBar;
  private TextView pendingAttachmentLabel;
  private Uri pendingAttachmentUri;
  private String pendingAttachmentName = "";
  private String pendingAttachmentContentType = "";
  private JSONObject pendingSaveDescriptor;
  private String pendingSaveSpaceId;
  private String requestedProfileId;
  private boolean demoMode;
  private boolean webSocketReady;
  private boolean awaitingAgentResponse;
  private boolean destroyed;
  private boolean resumed;
  private boolean deletingMessages;
  private Models.HermesChatProfile selectedProfile;
  private volatile long profileGeneration;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
      OnBackInvokedDispatcher.PRIORITY_DEFAULT,
      backCallback
    );
    getWindow().setNavigationBarContrastEnforced(false);
    demoMode = (getApplicationInfo().flags
      & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
      && getIntent().getBooleanExtra("demo", false);
    api = new NotesApiClient(this);
    secureStore = new SecureSessionStore(this);
    connection = HermesChatConnectionManager.get(this);
    requestedProfileId = getIntent().getStringExtra(EXTRA_PROFILE_ID);
    if (!demoMode) HermesChatCleanupService.schedule(this);
    cleanupStalePlaybackFiles();
    buildScreen();
    String requestedLabel = getIntent().getStringExtra(EXTRA_PROFILE_LABEL);
    if (requestedLabel != null && !requestedLabel.trim().isEmpty()) {
      chatTitle.setText(requestedLabel.trim());
    }
    if (demoMode) loadDemoConversation(requestedLabel);
    else loadProfiles();
  }

  @Override
  protected void onResume() {
    super.onResume();
    resumed = true;
    focusComposer(true);
  }

  @Override
  protected void onPause() {
    resumed = false;
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    destroyed = true;
    handler.removeCallbacksAndMessages(null);
    if (connectionListener != null) connection.detach(connectionListener);
    if (commandPaletteDialog != null) commandPaletteDialog.dismiss();
    cleanupPlaybackDialogs();
    cleanupPlaybackFiles();
    getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
    executor.shutdownNow();
    super.onDestroy();
  }

  private void handleSystemBack() {
    if (!selectedMessageIds.isEmpty()) {
      exitMessageSelection();
      return;
    }
    finish();
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode == REQUEST_ATTACHMENT) {
      if (resultCode != RESULT_OK || data == null || data.getData() == null) {
        focusComposer(true);
        return;
      }
      Uri uri = data.getData();
      try {
        getContentResolver().takePersistableUriPermission(
          uri,
          Intent.FLAG_GRANT_READ_URI_PERMISSION
        );
      } catch (SecurityException ignored) {
        // Some providers grant access for the Activity lifetime but do not support persistence.
      }
      stageAttachment(uri);
      return;
    }
    if (requestCode == REQUEST_SAVE_ATTACHMENT) {
      JSONObject descriptor = pendingSaveDescriptor;
      String spaceId = pendingSaveSpaceId;
      pendingSaveDescriptor = null;
      pendingSaveSpaceId = null;
      if (resultCode == RESULT_OK && data != null && data.getData() != null
          && descriptor != null && spaceId != null) {
        saveAttachmentToUri(data.getData(), descriptor, spaceId);
      } else {
        focusComposer(true);
      }
    }
  }

  @Override
  public void onReady() {
    runOnUiThread(() -> {
      webSocketReady = true;
      if (awaitingAgentResponse) markAwaitingAgentResponse();
      else showConnectionAwareStatus("已加密");
      sendButton.setEnabled(true);
    });
  }

  @Override
  public void onConnecting() {
    runOnUiThread(() -> {
      if (destroyed) return;
      webSocketReady = false;
      status.setText("WS 连接中 · 获取凭证…");
      status.setTextColor(getColor(R.color.text_secondary));
      sendButton.setEnabled(false);
    });
  }

  @Override
  public void onMessage(HermesChatCrypto.ChatMessage message) {
    persistMessage(message);
    runOnUiThread(() -> {
      if ("agent".equals(message.sender)) clearAwaitingAgentResponse();
      appendMessage(message);
      focusComposer(true);
    });
  }

  @Override
  public void onAcknowledged(String messageId, long sequence) {
    HermesChatHistoryStore targetStore = historyStore;
    long generation = profileGeneration;
    if (targetStore == null || sequence < 1) return;
    executor.submit(() -> {
      if (!destroyed && generation == profileGeneration && historyStore == targetStore) {
        targetStore.acknowledge(messageId, sequence);
      }
    });
    runOnUiThread(() -> {
      RenderedMessage rendered = renderedMessagesById.get(messageId);
      if (rendered == null || sequence < 1) return;
      HermesChatCrypto.ChatMessage current = rendered.message;
      rendered.message = new HermesChatCrypto.ChatMessage(
        current.id,
        current.sender,
        current.sentAt,
        sequence,
        current.text,
        current.attachments
      );
      renderedMessagesBySequence.put(sequence, rendered);
    });
  }

  @Override
  public void onTyping(boolean active) {
    runOnUiThread(() -> {
      if (active) markAwaitingAgentResponse();
    });
  }

  @Override
  public void onDisconnected(String reason) {
    runOnUiThread(() -> {
      webSocketReady = false;
      status.setText("WS 已断开 · 正在重试…");
      status.setTextColor(getColor(R.color.warning));
      sendButton.setEnabled(false);
      if (reason != null && reason.contains("401")) toast("聊天授权已过期，正在重新认证。");
    });
  }

  private final Runnable expireAwaitingAgentResponse = () -> {
    awaitingAgentResponse = false;
    if (webSocketReady) showConnectionAwareStatus("已加密");
  };

  private void markAwaitingAgentResponse() {
    awaitingAgentResponse = true;
    handler.removeCallbacks(expireAwaitingAgentResponse);
    showConnectionAwareStatus("正在思考…");
    handler.postDelayed(expireAwaitingAgentResponse, AWAITING_RESPONSE_TIMEOUT_MS);
  }

  private void clearAwaitingAgentResponse() {
    awaitingAgentResponse = false;
    handler.removeCallbacks(expireAwaitingAgentResponse);
    if (webSocketReady) showConnectionAwareStatus("已加密");
  }

  private void showConnectionAwareStatus(String detail) {
    status.setText(
      (webSocketReady ? "WS 已连接 · " : "WS 未连接 · ") + detail
    );
    status.setTextColor(getColor(
      webSocketReady ? R.color.brand_primary_dark : R.color.text_secondary
    ));
  }

  private void buildScreen() {
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(getColor(R.color.background));
    LinearLayout column = vertical();
    root.addView(column, new FrameLayout.LayoutParams(-1, -1));

    LinearLayout top = horizontal(Gravity.CENTER_VERTICAL);
    normalHeader = top;
    top.setPadding(dp(8), dp(8), dp(8), dp(8));
    top.setBackgroundColor(getColor(R.color.surface));
    ImageButton back = iconButton(R.drawable.ic_arrow_back, "返回 Hermes 会话列表");
    back.setOnClickListener(view -> finish());
    top.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));

    FrameLayout avatar = chatAvatar();
    LinearLayout.LayoutParams avatarParams = new LinearLayout.LayoutParams(dp(44), dp(44));
    avatarParams.setMarginStart(dp(4));
    top.addView(avatar, avatarParams);

    LinearLayout heading = vertical();
    chatTitle = text("Hermes", 19, R.color.text_primary);
    chatTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    chatTitle.setSingleLine(true);
    chatTitle.setEllipsize(TextUtils.TruncateAt.END);
    heading.addView(chatTitle);
    status = text("WS 未连接 · 正在准备…", 12, R.color.text_secondary);
    status.setSingleLine(true);
    status.setEllipsize(TextUtils.TruncateAt.END);
    heading.addView(status);
    heading.setMinimumHeight(dp(52));
    LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(0, -2, 1);
    headingParams.setMarginStart(dp(8));
    heading.setContentDescription("返回 Hermes 会话列表");
    heading.setClickable(true);
    heading.setFocusable(true);
    heading.setOnClickListener(view -> finish());
    top.addView(heading, headingParams);

    ImageButton reconnect = iconButton(R.drawable.ic_refresh, "重新连接");
    reconnect.setOnClickListener(view -> connection.reconnect());
    top.addView(reconnect, new LinearLayout.LayoutParams(dp(48), dp(48)));
    ImageButton settings = iconButton(R.drawable.ic_more, "聊天与缓存设置");
    settings.setOnClickListener(this::showSettings);
    top.addView(settings, new LinearLayout.LayoutParams(dp(48), dp(48)));

    FrameLayout headerContainer = new FrameLayout(this);
    headerContainer.addView(top, new FrameLayout.LayoutParams(-1, -1));
    selectionHeader = horizontal(Gravity.CENTER_VERTICAL);
    selectionHeader.setPadding(dp(8), dp(8), dp(8), dp(8));
    selectionHeader.setBackgroundColor(getColor(R.color.surface));
    selectionHeader.setVisibility(View.GONE);
    ImageButton cancelSelection = iconButton(R.drawable.ic_arrow_back, "退出消息选择");
    cancelSelection.setOnClickListener(view -> exitMessageSelection());
    selectionHeader.addView(cancelSelection, new LinearLayout.LayoutParams(dp(48), dp(48)));
    selectionCount = text("已选择 0 条", 18, R.color.text_primary);
    selectionCount.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    LinearLayout.LayoutParams countParams = new LinearLayout.LayoutParams(0, dp(48), 1);
    countParams.setMarginStart(dp(10));
    selectionHeader.addView(selectionCount, countParams);
    ImageButton deleteSelection = iconButton(R.drawable.ic_trash, "删除所选消息");
    deleteSelection.setImageTintList(ColorStateList.valueOf(getColor(R.color.danger)));
    deleteSelection.setOnClickListener(view -> confirmDeleteSelectedMessages());
    selectionHeader.addView(deleteSelection, new LinearLayout.LayoutParams(dp(48), dp(48)));
    headerContainer.addView(selectionHeader, new FrameLayout.LayoutParams(-1, -1));
    column.addView(headerContainer, new LinearLayout.LayoutParams(-1, dp(68)));

    TextView privacy = text(
      "消息和附件端到端加密，本机加密缓存默认保留 30 天。",
      12,
      R.color.text_secondary
    );
    privacy.setGravity(Gravity.CENTER);
    privacy.setPadding(dp(16), dp(7), dp(16), dp(7));
    privacy.setBackground(rounded(R.color.surface_tonal, 14));
    LinearLayout.LayoutParams privacyParams = new LinearLayout.LayoutParams(-1, -2);
    privacyParams.setMargins(dp(12), dp(6), dp(12), dp(8));
    column.addView(privacy, privacyParams);

    messageScroll = new ScrollView(this);
    messageScroll.setFillViewport(true);
    messageScroll.setBackgroundColor(getColor(R.color.surface_variant));
    messages = vertical();
    messages.setPadding(dp(12), dp(12), dp(12), dp(12));
    messageScroll.addView(messages, new ScrollView.LayoutParams(-1, -2));
    column.addView(messageScroll, new LinearLayout.LayoutParams(-1, 0, 1));

    LinearLayout composePanel = vertical();
    composePanel.setPadding(dp(10), dp(8), dp(10), dp(10));
    composePanel.setBackgroundColor(getColor(R.color.surface));

    commandSuggestions = vertical();
    commandSuggestions.setPadding(dp(6), dp(6), dp(6), dp(6));
    commandSuggestions.setBackground(roundedStroke(
      R.color.background,
      R.color.divider,
      16,
      1
    ));
    commandSuggestions.setVisibility(View.GONE);
    LinearLayout.LayoutParams suggestionParams = new LinearLayout.LayoutParams(-1, -2);
    suggestionParams.setMargins(0, 0, 0, dp(8));
    composePanel.addView(commandSuggestions, suggestionParams);

    pendingAttachmentBar = horizontal(Gravity.CENTER_VERTICAL);
    pendingAttachmentBar.setPadding(dp(12), dp(7), dp(8), dp(7));
    pendingAttachmentBar.setBackground(rounded(R.color.surface_tonal, 14));
    pendingAttachmentBar.setVisibility(View.GONE);
    pendingAttachmentLabel = text("", 13, R.color.text_primary);
    pendingAttachmentLabel.setSingleLine(true);
    pendingAttachmentLabel.setEllipsize(TextUtils.TruncateAt.MIDDLE);
    pendingAttachmentBar.addView(
      pendingAttachmentLabel,
      new LinearLayout.LayoutParams(0, dp(40), 1)
    );
    Button removeAttachment = new Button(this);
    removeAttachment.setText("移除");
    removeAttachment.setTextSize(12);
    removeAttachment.setTextColor(getColor(R.color.danger));
    removeAttachment.setAllCaps(false);
    removeAttachment.setBackground(rounded(R.color.background, 12));
    removeAttachment.setOnClickListener(view -> clearPendingAttachment());
    pendingAttachmentBar.addView(
      removeAttachment,
      new LinearLayout.LayoutParams(dp(64), dp(40))
    );
    LinearLayout.LayoutParams pendingParams = new LinearLayout.LayoutParams(-1, -2);
    pendingParams.setMargins(0, 0, 0, dp(8));
    composePanel.addView(pendingAttachmentBar, pendingParams);

    LinearLayout compose = horizontal(Gravity.BOTTOM);
    ImageButton attachment = iconButton(R.drawable.ic_attach_file, "添加图片或文件");
    attachment.setOnClickListener(view -> chooseAttachment());
    compose.addView(attachment, new LinearLayout.LayoutParams(dp(48), dp(48)));
    Button commandButton = new Button(this);
    commandButton.setText("/");
    commandButton.setTextSize(23);
    commandButton.setTextColor(getColor(R.color.brand_primary_dark));
    commandButton.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
    commandButton.setAllCaps(false);
    commandButton.setContentDescription("打开 Hermes 快捷指令");
    commandButton.setBackground(rounded(R.color.surface_tonal, 16));
    commandButton.setOnClickListener(view -> showCommandPalette());
    LinearLayout.LayoutParams commandButtonParams = new LinearLayout.LayoutParams(dp(48), dp(48));
    commandButtonParams.setMarginStart(dp(6));
    compose.addView(commandButton, commandButtonParams);
    composer = new EditText(this);
    composer.setHint("给 Hermes 发消息");
    composer.setTextColor(getColor(R.color.text_primary));
    composer.setHintTextColor(getColor(R.color.text_secondary));
    composer.setTextSize(16);
    composer.setMaxLines(5);
    composer.setPadding(dp(14), dp(8), dp(14), dp(8));
    composer.setBackground(roundedStroke(R.color.background, R.color.divider, 18, 1));
    composer.addTextChangedListener(new TextWatcher() {
      @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
      @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
        connection.sendTyping(s.length() > 0);
        updateCommandSuggestions(s.toString());
      }
      @Override public void afterTextChanged(Editable editable) {}
    });
    LinearLayout.LayoutParams composerParams = new LinearLayout.LayoutParams(0, -2, 1);
    composerParams.setMargins(dp(8), 0, dp(8), 0);
    compose.addView(composer, composerParams);
    sendButton = new Button(this);
    sendButton.setText("发送");
    sendButton.setTextColor(getColor(R.color.on_brand));
    sendButton.setTextSize(14);
    sendButton.setAllCaps(false);
    sendButton.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    sendButton.setBackground(rounded(R.color.brand_primary, 18));
    sendButton.setEnabled(false);
    sendButton.setOnClickListener(view -> sendCurrentMessage());
    compose.addView(sendButton, new LinearLayout.LayoutParams(dp(68), dp(48)));
    composePanel.addView(compose, new LinearLayout.LayoutParams(-1, -2));
    column.addView(composePanel, new LinearLayout.LayoutParams(-1, -2));

    setContentView(applyInsets(root));
  }

  private void loadProfiles() {
    showConnectionAwareStatus("正在加载 Hermes 聊天对象…");
    executor.submit(() -> {
      try {
        NotesApiClient.SessionResult session = api.restoreSession();
        if (!session.authenticated) throw new IllegalStateException("请先在 My Notes 登录。");
        List<Models.HermesChatProfile> profiles = api.hermesChatProfiles();
        if (profiles.isEmpty()) throw new IllegalStateException("尚未配置 Hermes profile。");
        Models.HermesChatProfile requestedProfile = null;
        for (Models.HermesChatProfile profile : profiles) {
          if (profile.id.equals(requestedProfileId)) {
            requestedProfile = profile;
            break;
          }
        }
        if (requestedProfile == null) {
          throw new IllegalStateException("该 Hermes 聊天对象不存在或已停用。");
        }
        Models.HermesChatProfile targetProfile = requestedProfile;
        runOnUiThread(() -> {
          if (destroyed) return;
          selectProfile(targetProfile);
        });
      } catch (Exception error) {
        runOnUiThread(() -> {
          showConnectionAwareStatus("无法加载 Hermes 聊天对象");
          toast(error.getMessage());
        });
      }
    });
  }

  private void loadDemoConversation(String requestedLabel) {
    String profileId = requestedProfileId == null ? "personal" : requestedProfileId;
    String profileLabel = requestedLabel == null || requestedLabel.trim().isEmpty()
      ? "Hermes 个人助手"
      : requestedLabel.trim();
    selectedProfile = new Models.HermesChatProfile(profileId, profileLabel);
    chatTitle.setText(profileLabel);
    showConnectionAwareStatus("演示模式");
    long now = System.currentTimeMillis();
    appendMessage(new HermesChatCrypto.ChatMessage(
      "demo-agent-1",
      "agent",
      now - 180_000,
      1,
      "## Hermes profile 已就绪\n"
        + "消息、附件和本机缓存都按聊天对象隔离。代码示例：\n\n"
        + "```bash\nhermes status\n```",
      new JSONArray()
    ));
    appendMessage(new HermesChatCrypto.ChatMessage(
      "demo-client-1",
      "client",
      now - 120_000,
      2,
      "帮我整理今天的个人计划。",
      new JSONArray()
    ));
    appendMessage(new HermesChatCrypto.ChatMessage(
      "demo-agent-2",
      "agent",
      now - 60_000,
      3,
      "可以。先列出最重要的三件事，我会把它们整理成清晰的执行顺序。",
      new JSONArray()
    ));
    if (getIntent().getBooleanExtra(EXTRA_DEMO_AWAITING, false)) {
      webSocketReady = true;
      markAwaitingAgentResponse();
    }
  }

  private void selectProfile(Models.HermesChatProfile profile) {
    if (destroyed) return;
    profileGeneration += 1;
    handler.removeCallbacksAndMessages(null);
    webSocketReady = false;
    awaitingAgentResponse = false;
    if (connectionListener != null) connection.detach(connectionListener);
    connectionListener = null;
    connection.closeUnless(profile.id);
    selectedProfile = profile;
    crypto = null;
    historyStore = null;
    imageCache = null;
    renderedMessageIds.clear();
    renderedMessagesBySequence.clear();
    renderedMessagesById.clear();
    selectedMessageIds.clear();
    updateMessageSelectionUi();
    messages.removeAllViews();
    composer.setText("");
    clearPendingAttachment();
    sendButton.setEnabled(false);
    chatTitle.setText(profile.label);
    showConnectionAwareStatus("正在准备独立加密会话…");
    String key = secureStore.loadHermesChatKey(profile.id);
    if (key.isEmpty()) showKeySetup(false);
    else startWithKey(key);
  }

  private void startWithKey(String encodedKey) {
    if (selectedProfile == null) return;
    try {
      HermesChatCrypto targetCrypto = new HermesChatCrypto(encodedKey);
      sendButton.setEnabled(false);
      String spaceId = selectedProfile.id;
      long generation = profileGeneration;
      showConnectionAwareStatus("正在加载本地加密聊天记录…");
      executor.submit(() -> {
        HermesChatHistoryStore targetHistory = new HermesChatHistoryStore(
          this,
          spaceId,
          targetCrypto
        );
        HermesChatImageCache targetImages = new HermesChatImageCache(this, spaceId);
        HermesChatHistoryStore.Snapshot snapshot = targetHistory.loadAndCleanup(
          HermesChatCacheSettings.retentionDays(this),
          System.currentTimeMillis()
        );
        targetImages.retain(snapshot.messages);
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration || selectedProfile == null
              || !spaceId.equals(selectedProfile.id)) return;
          crypto = targetCrypto;
          historyStore = targetHistory;
          imageCache = targetImages;
          renderCachedMessages(snapshot);
          connectionListener = scopedListener(generation);
          try {
            connection.attach(
              spaceId,
              encodedKey,
              snapshot.lastSequence,
              connectionListener
            );
          } catch (Exception error) {
            toast(error.getMessage());
            showConnectionAwareStatus("无法启动聊天连接");
          }
        });
      });
    } catch (Exception error) {
      secureStore.clearHermesChatKey(selectedProfile.id);
      toast(error.getMessage());
      showKeySetup(false);
    }
  }

  private HermesChatConnectionManager.Listener scopedListener(long generation) {
    return new HermesChatConnectionManager.Listener() {
      private boolean active() {
        return !destroyed && generation == profileGeneration;
      }

      @Override public void onReady() {
        if (active()) HermesChatActivity.this.onReady();
      }

      @Override public void onConnecting() {
        if (active()) HermesChatActivity.this.onConnecting();
      }

      @Override public void onMessage(HermesChatCrypto.ChatMessage message) {
        if (active()) HermesChatActivity.this.onMessage(message);
      }

      @Override public void onAcknowledged(String messageId, long sequence) {
        if (active()) HermesChatActivity.this.onAcknowledged(messageId, sequence);
      }

      @Override public void onTyping(boolean active) {
        if (this.active()) HermesChatActivity.this.onTyping(active);
      }

      @Override public void onDisconnected(String reason) {
        if (active()) HermesChatActivity.this.onDisconnected(reason);
      }
    };
  }

  private void updateCommandSuggestions(String value) {
    if (commandSuggestions == null) return;
    if (suppressedCommandSuggestionText != null
        && suppressedCommandSuggestionText.equals(value)) {
      commandSuggestions.setVisibility(View.GONE);
      return;
    }
    suppressedCommandSuggestionText = null;
    if (!isSlashCommandPrefix(value)) {
      commandSuggestions.setVisibility(View.GONE);
      return;
    }
    List<HermesCommandCatalog.Command> suggestions =
      HermesCommandCatalog.suggestions(value, 6);
    commandSuggestions.removeAllViews();
    if (suggestions.isEmpty()) {
      commandSuggestions.setVisibility(View.GONE);
      return;
    }
    TextView heading = text("Hermes 指令 · 点按后填入输入框", 12, R.color.text_secondary);
    heading.setPadding(dp(10), dp(4), dp(10), dp(6));
    commandSuggestions.addView(heading, new LinearLayout.LayoutParams(-1, -2));
    for (HermesCommandCatalog.Command command : suggestions) {
      commandSuggestions.addView(
        commandRow(command, true),
        commandRowParams()
      );
    }
    TextView all = text("查看全部快捷指令", 13, R.color.brand_primary_dark);
    all.setGravity(Gravity.CENTER);
    all.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    all.setPadding(dp(10), dp(10), dp(10), dp(10));
    all.setBackground(rounded(R.color.surface_tonal, 12));
    all.setClickable(true);
    all.setFocusable(true);
    all.setOnClickListener(view -> showCommandPalette());
    LinearLayout.LayoutParams allParams = new LinearLayout.LayoutParams(-1, dp(44));
    allParams.setMargins(dp(2), dp(3), dp(2), dp(2));
    commandSuggestions.addView(all, allParams);
    commandSuggestions.setVisibility(View.VISIBLE);
  }

  private static boolean isSlashCommandPrefix(String value) {
    if (value == null || !value.startsWith("/") || value.contains("\n")) return false;
    for (int index = 1; index < value.length(); index++) {
      if (Character.isWhitespace(value.charAt(index))) return false;
    }
    return true;
  }

  private View commandRow(HermesCommandCatalog.Command command, boolean compact) {
    LinearLayout row = vertical();
    row.setPadding(dp(12), compact ? dp(7) : dp(10), dp(12), compact ? dp(7) : dp(10));
    row.setBackground(rounded(R.color.surface_tonal, 12));
    TextView name = text(command.usage(), compact ? 14 : 15, R.color.text_primary);
    name.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
    name.setSingleLine(true);
    name.setEllipsize(TextUtils.TruncateAt.END);
    row.addView(name, new LinearLayout.LayoutParams(-1, -2));
    String detail = (command.caution ? "需确认 · " : "") + command.description;
    TextView description = text(detail, compact ? 11 : 12,
      command.caution ? R.color.warning : R.color.text_secondary);
    description.setMaxLines(compact ? 1 : 2);
    description.setEllipsize(TextUtils.TruncateAt.END);
    row.addView(description, new LinearLayout.LayoutParams(-1, -2));
    row.setContentDescription(command.usage() + "，" + detail);
    row.setClickable(true);
    row.setFocusable(true);
    row.setOnClickListener(view -> chooseCommand(command));
    return row;
  }

  private LinearLayout.LayoutParams commandRowParams() {
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
    params.setMargins(dp(2), dp(2), dp(2), dp(2));
    return params;
  }

  private void showCommandPalette() {
    if (commandPaletteDialog != null) commandPaletteDialog.dismiss();
    android.view.WindowInsetsController insetsController = getWindow().getInsetsController();
    if (insetsController != null) insetsController.hide(WindowInsets.Type.ime());

    Dialog dialog = new Dialog(this);
    commandPaletteDialog = dialog;
    LinearLayout root = vertical();
    root.setPadding(dp(16), dp(14), dp(16), dp(12));
    root.setBackground(rounded(R.color.surface, 24));

    LinearLayout titleRow = horizontal(Gravity.CENTER_VERTICAL);
    LinearLayout titleText = vertical();
    TextView title = text("Hermes 快捷指令", 20, R.color.text_primary);
    title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    titleText.addView(title);
    TextView subtitle = text(
      "选择后只会填入输入框，不会自动执行",
      12,
      R.color.text_secondary
    );
    titleText.addView(subtitle);
    titleRow.addView(titleText, new LinearLayout.LayoutParams(0, -2, 1));
    Button close = new Button(this);
    close.setText("关闭");
    close.setTextSize(13);
    close.setTextColor(getColor(R.color.brand_primary_dark));
    close.setAllCaps(false);
    close.setBackground(rounded(R.color.surface_tonal, 14));
    close.setOnClickListener(view -> {
      dialog.dismiss();
      focusComposer(true);
    });
    titleRow.addView(close, new LinearLayout.LayoutParams(dp(64), dp(44)));
    root.addView(titleRow, new LinearLayout.LayoutParams(-1, -2));

    TextView sourceNote = text(
      "内置目录按 Hermes 官方“消息平台指令”整理；当前 NAS 版本、已安装 skills "
        + "和 quick_commands 以 /commands 的回复为准。",
      12,
      R.color.text_secondary
    );
    sourceNote.setPadding(0, dp(10), 0, dp(10));
    root.addView(sourceNote, new LinearLayout.LayoutParams(-1, -2));

    ScrollView scroll = new ScrollView(this);
    LinearLayout content = vertical();
    TextView quickTitle = text("常用操作", 14, R.color.text_primary);
    quickTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    quickTitle.setPadding(dp(2), dp(2), dp(2), dp(6));
    content.addView(quickTitle, new LinearLayout.LayoutParams(-1, -2));

    HorizontalScrollView quickScroll = new HorizontalScrollView(this);
    quickScroll.setHorizontalScrollBarEnabled(false);
    LinearLayout quickActions = horizontal(Gravity.CENTER_VERTICAL);
    for (HermesCommandCatalog.Command command : HermesCommandCatalog.featured()) {
      Button chip = new Button(this);
      chip.setText(command.invocation());
      chip.setTextSize(13);
      chip.setTextColor(getColor(command.caution
        ? R.color.warning
        : R.color.brand_primary_dark));
      chip.setAllCaps(false);
      chip.setMinWidth(dp(76));
      chip.setBackground(rounded(R.color.surface_tonal, 14));
      chip.setContentDescription(command.description);
      chip.setOnClickListener(view -> chooseCommand(command));
      LinearLayout.LayoutParams chipParams = new LinearLayout.LayoutParams(-2, dp(46));
      chipParams.setMargins(0, 0, dp(8), 0);
      quickActions.addView(chip, chipParams);
    }
    quickScroll.addView(quickActions, new HorizontalScrollView.LayoutParams(-2, -1));
    LinearLayout.LayoutParams quickScrollParams = new LinearLayout.LayoutParams(-1, dp(48));
    quickScrollParams.setMargins(0, 0, 0, dp(10));
    content.addView(quickScroll, quickScrollParams);

    for (String category : HermesCommandCatalog.categories()) {
      TextView categoryTitle = text(category, 14, R.color.text_primary);
      categoryTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
      categoryTitle.setPadding(dp(2), dp(12), dp(2), dp(4));
      content.addView(categoryTitle, new LinearLayout.LayoutParams(-1, -2));
      for (HermesCommandCatalog.Command command : HermesCommandCatalog.all()) {
        if (!category.equals(command.category)) continue;
        content.addView(commandRow(command, false), commandRowParams());
      }
    }

    Button officialReference = new Button(this);
    officialReference.setText("打开 Hermes 官方指令文档");
    officialReference.setTextSize(13);
    officialReference.setTextColor(getColor(R.color.brand_primary_dark));
    officialReference.setAllCaps(false);
    officialReference.setBackground(roundedStroke(
      R.color.background,
      R.color.divider,
      14,
      1
    ));
    officialReference.setOnClickListener(view -> {
      Intent intent = new Intent(
        Intent.ACTION_VIEW,
        Uri.parse(HermesCommandCatalog.OFFICIAL_REFERENCE)
      );
      startActivity(intent);
    });
    LinearLayout.LayoutParams referenceParams = new LinearLayout.LayoutParams(-1, dp(48));
    referenceParams.setMargins(dp(2), dp(14), dp(2), dp(8));
    content.addView(officialReference, referenceParams);

    scroll.addView(content, new ScrollView.LayoutParams(-1, -2));
    root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
    dialog.setContentView(root);
    dialog.setOnDismissListener(ignored -> {
      if (commandPaletteDialog == dialog) commandPaletteDialog = null;
    });
    dialog.show();
    Window window = dialog.getWindow();
    if (window != null) {
      window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
      window.setGravity(Gravity.BOTTOM);
      window.setDimAmount(0.36f);
      window.setLayout(
        ViewGroup.LayoutParams.MATCH_PARENT,
        Math.round(getResources().getDisplayMetrics().heightPixels * 0.86f)
      );
    }
  }

  private void chooseCommand(HermesCommandCatalog.Command command) {
    Dialog palette = commandPaletteDialog;
    if (palette != null) palette.dismiss();
    commandSuggestions.setVisibility(View.GONE);
    if (command.actions.isEmpty()) {
      insertCommand(command.invocation(), command.caution);
      return;
    }
    String[] labels = new String[command.actions.size()];
    for (int index = 0; index < command.actions.size(); index++) {
      labels[index] = command.actions.get(index).label;
    }
    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle(command.usage() + (command.caution ? " · 需确认" : ""))
      .setItems(labels, (ignored, which) -> {
        HermesCommandCatalog.Action action = command.actions.get(which);
        if (action.needsInput()) showCommandInput(command, action);
        else insertCommand(action.fixedCommand(), command.caution);
      })
      .setNegativeButton("取消", null)
      .create();
    dialog.setOnDismissListener(ignored -> {
      if (!destroyed && (composer == null || composer.getText().length() == 0)) {
        focusComposer(true);
      }
    });
    dialog.show();
  }

  private void showCommandInput(
    HermesCommandCatalog.Command command,
    HermesCommandCatalog.Action action
  ) {
    EditText field = new EditText(this);
    field.setHint(action.inputHint);
    field.setTextColor(getColor(R.color.text_primary));
    field.setHintTextColor(getColor(R.color.text_secondary));
    field.setTextSize(16);
    field.setMaxLines(3);
    field.setPadding(dp(14), dp(10), dp(14), dp(10));
    field.setBackground(roundedStroke(R.color.background, R.color.divider, 16, 1));
    LinearLayout wrapper = vertical();
    wrapper.setPadding(dp(24), dp(4), dp(24), 0);
    TextView explanation = text(
      "会生成 " + action.prefix + "…" + action.suffix + "，填入后可继续编辑。",
      12,
      R.color.text_secondary
    );
    wrapper.addView(explanation, new LinearLayout.LayoutParams(-1, -2));
    LinearLayout.LayoutParams fieldParams = new LinearLayout.LayoutParams(-1, -2);
    fieldParams.setMargins(0, dp(10), 0, 0);
    wrapper.addView(field, fieldParams);

    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle(action.label)
      .setView(wrapper)
      .setPositiveButton("填入输入框", null)
      .setNegativeButton("取消", null)
      .create();
    dialog.setOnShowListener(ignored -> {
      dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
        String value = field.getText().toString().trim();
        if (value.isEmpty()) {
          field.setError("请填写参数");
          return;
        }
        dialog.dismiss();
        insertCommand(action.commandWith(value), command.caution);
      });
      field.requestFocus();
      android.view.WindowInsetsController controller = dialog.getWindow() == null
        ? null
        : dialog.getWindow().getInsetsController();
      if (controller != null) controller.show(WindowInsets.Type.ime());
    });
    dialog.setOnDismissListener(ignored -> {
      if (!destroyed && (composer == null || composer.getText().length() == 0)) {
        focusComposer(true);
      }
    });
    dialog.show();
  }

  private void insertCommand(String value, boolean caution) {
    suppressedCommandSuggestionText = value;
    composer.setText(value);
    composer.setSelection(composer.length());
    commandSuggestions.setVisibility(View.GONE);
    if (caution) toast("指令已填入，发送前请确认影响。");
    focusComposer(true);
  }

  private void sendCurrentMessage() {
    if (pendingAttachmentUri != null) sendAttachment(pendingAttachmentUri);
    else sendText();
  }

  private void sendText() {
    String value = composer.getText().toString().trim();
    if (value.isEmpty()) return;
    try {
      HermesChatCrypto.ChatMessage message = connection.sendMessage(value, new JSONArray());
      composer.setText("");
      appendMessage(message);
      persistMessage(message);
      markAwaitingAgentResponse();
      focusComposer(true);
    } catch (Exception error) {
      toast(error.getMessage());
      focusComposer(true);
    }
  }

  private void chooseAttachment() {
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType("*/*");
    intent.addFlags(
      Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
    );
    startActivityForResult(intent, REQUEST_ATTACHMENT);
  }

  private void stageAttachment(Uri uri) {
    try {
      String name = displayName(uri);
      HermesChatAttachmentPolicy.ResolvedType resolved = HermesChatAttachmentPolicy.resolve(
        getContentResolver().getType(uri),
        name
      );
      long size = displaySize(uri);
      if (size > HermesChatCrypto.MAX_ATTACHMENT_BYTES) {
        throw new IllegalArgumentException("附件超过 10 MiB 限制。");
      }
      pendingAttachmentUri = uri;
      pendingAttachmentName = HermesChatAttachmentPolicy.safeDisplayName(name, resolved);
      pendingAttachmentContentType = resolved.contentType;
      pendingAttachmentLabel.setText(
        resolved.category.label + " · " + pendingAttachmentName + " · "
          + HermesChatAttachmentPolicy.formatBytes(size) + " · 可添加说明"
      );
      pendingAttachmentBar.setVisibility(View.VISIBLE);
      showConnectionAwareStatus("附件已添加，点击发送后才会上传");
      focusComposer(true);
    } catch (Exception error) {
      clearPendingAttachment();
      toast(error.getMessage());
      focusComposer(true);
    }
  }

  private void clearPendingAttachment() {
    pendingAttachmentUri = null;
    pendingAttachmentName = "";
    pendingAttachmentContentType = "";
    if (pendingAttachmentLabel != null) pendingAttachmentLabel.setText("");
    if (pendingAttachmentBar != null) pendingAttachmentBar.setVisibility(View.GONE);
    focusComposer(true);
  }

  private void sendAttachment(Uri uri) {
    if (!connection.isReady() || selectedProfile == null) {
      toast("请等待 Hermes 连接成功后再发送附件。");
      return;
    }
    String spaceId = selectedProfile.id;
    HermesChatCrypto targetCrypto = crypto;
    HermesChatConnectionManager targetConnection = connection;
    long generation = profileGeneration;
    showConnectionAwareStatus("正在加密并上传附件…");
    String caption = composer.getText().toString().trim();
    String filename = pendingAttachmentName;
    String contentType = pendingAttachmentContentType;
    sendButton.setEnabled(false);
    executor.submit(() -> {
      try {
        byte[] data = readBounded(uri, HermesChatCrypto.MAX_ATTACHMENT_BYTES);
        HermesChatAttachmentPolicy.ResolvedType resolved = HermesChatAttachmentPolicy.resolve(
          contentType,
          filename
        );
        HermesChatCrypto.EncryptedAttachment encrypted = targetCrypto.encryptAttachment(
          data,
          resolved.contentType,
          HermesChatAttachmentPolicy.safeDisplayName(filename, resolved)
        );
        api.uploadHermesChatAttachment(
          spaceId,
          encrypted.descriptor.getString("id"),
          encrypted.ciphertext
        );
        HermesChatImageCache targetImages = imageCache;
        if (targetImages != null) targetImages.write(encrypted.descriptor, encrypted.ciphertext);
        JSONArray attachments = new JSONArray().put(encrypted.descriptor);
        HermesChatCrypto.ChatMessage message = targetConnection.sendMessage(caption, attachments);
        HermesChatHistoryStore targetHistory = historyStore;
        if (targetHistory != null) targetHistory.record(message);
        runOnUiThread(() -> {
          if (generation != profileGeneration || selectedProfile == null
              || !spaceId.equals(selectedProfile.id)
              || !targetConnection.isCurrentProfile(spaceId)) return;
          composer.setText("");
          if (uri.equals(pendingAttachmentUri)) clearPendingAttachment();
          appendMessage(message);
          markAwaitingAgentResponse();
          sendButton.setEnabled(true);
          focusComposer(true);
        });
      } catch (Exception error) {
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration) return;
          toast(error.getMessage());
          showConnectionAwareStatus("附件发送失败");
          sendButton.setEnabled(connection.isReady());
          focusComposer(true);
        });
      }
    });
  }

  private void renderCachedMessages(HermesChatHistoryStore.Snapshot snapshot) {
    renderedMessageIds.clear();
    renderedMessagesBySequence.clear();
    renderedMessagesById.clear();
    selectedMessageIds.clear();
    updateMessageSelectionUi();
    messages.removeAllViews();
    for (HermesChatCrypto.ChatMessage message : snapshot.messages) appendMessage(message);
    if (!snapshot.messages.isEmpty()) {
      showConnectionAwareStatus(
        "已加载 " + snapshot.messages.size() + " 条本地加密消息，正在连接…"
      );
    }
  }

  private void persistMessage(HermesChatCrypto.ChatMessage message) {
    HermesChatHistoryStore targetStore = historyStore;
    long generation = profileGeneration;
    if (targetStore == null) return;
    executor.submit(() -> {
      if (!destroyed && generation == profileGeneration && historyStore == targetStore) {
        targetStore.record(message);
      }
    });
  }

  private void toggleMessageSelection(RenderedMessage rendered) {
    if (rendered == null || deletingMessages) return;
    if (rendered.streaming) {
      toast("请等待 Hermes 完成这条回复后再删除。");
      return;
    }
    if (rendered.message.sequence < 1) {
      toast("消息正在发送，请收到服务器确认后再删除。");
      return;
    }
    String messageId = rendered.message.id;
    if (selectedMessageIds.contains(messageId)) {
      selectedMessageIds.remove(messageId);
    } else {
      if (selectedMessageIds.size() >= 100) {
        toast("一次最多选择 100 条消息。");
        return;
      }
      selectedMessageIds.add(messageId);
    }
    updateMessageSelectionUi();
  }

  private void updateMessageSelectionUi() {
    boolean selecting = !selectedMessageIds.isEmpty();
    if (normalHeader != null) normalHeader.setVisibility(selecting ? View.GONE : View.VISIBLE);
    if (selectionHeader != null) selectionHeader.setVisibility(selecting ? View.VISIBLE : View.GONE);
    if (selectionCount != null) {
      selectionCount.setText("已选择 " + selectedMessageIds.size() + " 条");
    }
    for (RenderedMessage rendered : renderedMessagesById.values()) {
      boolean selected = selectedMessageIds.contains(rendered.message.id);
      rendered.body.setTextIsSelectable(!selecting);
      int background = rendered.outgoing ? R.color.brand_primary : R.color.surface_tonal;
      rendered.bubble.setBackground(selected
        ? roundedStroke(background, R.color.brand_primary_dark, 18, 2)
        : rounded(background, 18));
    }
    if (selecting) {
      android.view.WindowInsetsController controller = getWindow().getInsetsController();
      if (controller != null) controller.hide(WindowInsets.Type.ime());
    }
  }

  private void exitMessageSelection() {
    if (deletingMessages) return;
    selectedMessageIds.clear();
    updateMessageSelectionUi();
    focusComposer(true);
  }

  private void confirmDeleteSelectedMessages() {
    if (selectedMessageIds.isEmpty() || deletingMessages) return;
    if (demoMode) {
      toast("演示模式只展示消息选择，不执行云端删除。");
      return;
    }
    int count = selectedMessageIds.size();
    new AlertDialog.Builder(this)
      .setTitle("永久删除 " + count + " 条消息？")
      .setMessage(
        "会从本机加密缓存、Cloudflare 消息历史和对应 R2 附件中删除，无法恢复。"
          + "已经由 Hermes 处理过的内容不会从 NAS Agent 当前上下文中撤回。"
      )
      .setPositiveButton("删除", (dialog, which) -> deleteSelectedMessages())
      .setNegativeButton("取消", null)
      .show();
  }

  private void deleteSelectedMessages() {
    Models.HermesChatProfile targetProfile = selectedProfile;
    HermesChatHistoryStore targetHistory = historyStore;
    HermesChatImageCache targetCache = imageCache;
    if (targetProfile == null || targetHistory == null || targetCache == null
        || selectedMessageIds.isEmpty()) return;
    Set<String> messageIds = new HashSet<>(selectedMessageIds);
    Set<String> attachmentIds = new HashSet<>();
    for (String messageId : messageIds) {
      RenderedMessage rendered = renderedMessagesById.get(messageId);
      if (rendered == null) continue;
      JSONArray attachments = rendered.message.attachments;
      for (int index = 0; index < attachments.length(); index++) {
        JSONObject descriptor = attachments.optJSONObject(index);
        String attachmentId = descriptor == null ? "" : descriptor.optString("id");
        if (!attachmentId.isEmpty()) attachmentIds.add(attachmentId);
      }
    }
    String spaceId = targetProfile.id;
    long generation = profileGeneration;
    deletingMessages = true;
    showConnectionAwareStatus("正在删除所选消息和附件…");
    executor.submit(() -> {
      try {
        JSONObject cloud = api.deleteHermesChatMessages(spaceId, messageIds, attachmentIds);
        HermesChatHistoryStore.Snapshot snapshot = targetHistory.deleteMessages(messageIds);
        targetCache.retain(snapshot.messages);
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration || historyStore != targetHistory) return;
          deletingMessages = false;
          removeRenderedMessages(messageIds);
          restoreConversationStatus();
          toast(
            "已删除 " + messageIds.size() + " 条消息；云端附件 "
              + cloud.optInt("attachmentsDeleted") + " 个。"
          );
          focusComposer(true);
        });
      } catch (Exception error) {
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration) return;
          deletingMessages = false;
          showConnectionAwareStatus("消息删除失败，可重试");
          toast(error.getMessage());
          updateMessageSelectionUi();
        });
      }
    });
  }

  private void removeRenderedMessages(Set<String> messageIds) {
    for (String messageId : messageIds) {
      RenderedMessage rendered = renderedMessagesById.remove(messageId);
      if (rendered == null) continue;
      messages.removeView(rendered.row);
      renderedMessageIds.remove(messageId);
      renderedMessagesBySequence.entrySet().removeIf(
        entry -> entry.getValue() == rendered
      );
    }
    selectedMessageIds.removeAll(messageIds);
    updateMessageSelectionUi();
  }

  private void appendMessage(HermesChatCrypto.ChatMessage message) {
    if (!renderedMessageIds.add(message.id)) return;
    if (message.replaceSequence > 0) {
      replaceMessage(message);
      return;
    }
    appendNewMessage(message);
  }

  private void appendNewMessage(HermesChatCrypto.ChatMessage message) {
    boolean outgoing = "client".equals(message.sender);
    LinearLayout row = horizontal(outgoing ? Gravity.END : Gravity.START);
    LinearLayout bubble = vertical();
    bubble.setPadding(dp(14), dp(10), dp(14), dp(10));
    bubble.setBackground(rounded(outgoing ? R.color.brand_primary : R.color.surface_tonal, 18));
    TextView body = text("", 16, outgoing ? R.color.on_brand : R.color.text_primary);
    setMessageBody(body, message.text, outgoing);
    int maximumWidth = (int) (getResources().getDisplayMetrics().widthPixels * 0.82f);
    body.setMaxWidth(Math.min(maximumWidth, dp(520)));
    body.setTextIsSelectable(selectedMessageIds.isEmpty());
    body.setVisibility(message.text.trim().isEmpty() ? View.GONE : View.VISIBLE);
    bubble.addView(body, new LinearLayout.LayoutParams(-2, -2));
    for (int index = 0; index < message.attachments.length(); index++) {
      JSONObject descriptor = message.attachments.optJSONObject(index);
      if (descriptor != null) addAttachmentPreview(bubble, descriptor, outgoing);
    }
    TextView meta = text(
      formatMessageTime(message.sentAt),
      11,
      outgoing ? R.color.on_brand : R.color.text_secondary
    );
    meta.setAlpha(0.78f);
    LinearLayout.LayoutParams metaParams = new LinearLayout.LayoutParams(-2, -2);
    metaParams.topMargin = dp(5);
    bubble.addView(meta, metaParams);
    row.addView(bubble, new LinearLayout.LayoutParams(-2, -2));
    LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(-1, -2);
    rowParams.setMargins(0, dp(5), 0, dp(5));
    messages.addView(row, rowParams);
    RenderedMessage rendered = new RenderedMessage(message, row, bubble, body, meta, outgoing);
    bubble.setTag(rendered);
    bubble.setOnLongClickListener(view -> {
      toggleMessageSelection(rendered);
      return true;
    });
    bubble.setOnClickListener(view -> {
      if (!selectedMessageIds.isEmpty()) toggleMessageSelection(rendered);
    });
    body.setOnLongClickListener(view -> {
      toggleMessageSelection(rendered);
      return true;
    });
    body.setOnClickListener(view -> {
      if (!selectedMessageIds.isEmpty()) toggleMessageSelection(rendered);
    });
    renderedMessagesById.put(message.id, rendered);
    if (message.sequence > 0) {
      renderedMessagesBySequence.put(message.sequence, rendered);
    }
    messageScroll.post(() -> messageScroll.fullScroll(View.FOCUS_DOWN));
  }

  private void replaceMessage(HermesChatCrypto.ChatMessage message) {
    RenderedMessage rendered = renderedMessagesBySequence.get(message.replaceSequence);
    if (rendered == null) {
      if (message.finalUpdate) {
        appendNewMessage(new HermesChatCrypto.ChatMessage(
          message.id,
          message.sender,
          message.sentAt,
          message.sequence,
          message.text,
          message.attachments
        ));
      }
      return;
    }
    TextView body = rendered.body;
    setMessageBody(body, message.text, "client".equals(message.sender));
    body.setVisibility(message.text.trim().isEmpty() ? View.GONE : View.VISIBLE);
    HermesChatCrypto.ChatMessage original = rendered.message;
    JSONArray attachments = message.attachments.length() > 0
      ? message.attachments
      : original.attachments;
    rendered.message = new HermesChatCrypto.ChatMessage(
      original.id,
      original.sender,
      original.sentAt,
      original.sequence,
      message.text,
      attachments
    );
    String sentTime = formatMessageTime(original.sentAt);
    rendered.meta.setText(message.finalUpdate ? sentTime : sentTime + " · 正在回复");
    rendered.streaming = !message.finalUpdate;
    messageScroll.post(() -> messageScroll.fullScroll(View.FOCUS_DOWN));
  }

  private static String formatMessageTime(long sentAt) {
    if (sentAt <= 0) return "时间未知";
    return MESSAGE_TIME_FORMATTER.format(
      Instant.ofEpochMilli(sentAt).atZone(ZoneId.systemDefault())
    );
  }

  private static final class RenderedMessage {
    HermesChatCrypto.ChatMessage message;
    final LinearLayout row;
    final LinearLayout bubble;
    final TextView body;
    final TextView meta;
    final boolean outgoing;
    boolean streaming;

    RenderedMessage(
      HermesChatCrypto.ChatMessage message,
      LinearLayout row,
      LinearLayout bubble,
      TextView body,
      TextView meta,
      boolean outgoing
    ) {
      this.message = message;
      this.row = row;
      this.bubble = bubble;
      this.body = body;
      this.meta = meta;
      this.outgoing = outgoing;
    }
  }

  private void setMessageBody(TextView body, String value, boolean outgoing) {
    String text = value == null ? "" : value;
    body.setText(HermesChatMarkdown.render(
      text,
      getColor(outgoing ? R.color.outgoing_code_background : R.color.code_background),
      getColor(outgoing ? R.color.outgoing_code_text : R.color.code_text),
      getColor(outgoing ? R.color.on_brand : R.color.brand_primary_dark),
      dp(10)
    ));
  }

  private void addAttachmentPreview(
    LinearLayout bubble,
    JSONObject descriptor,
    boolean outgoing
  ) {
    String name = descriptor.optString("name", "Hermes-附件");
    String contentType = descriptor.optString("contentType", "application/octet-stream");
    HermesChatAttachmentPolicy.ResolvedType resolved;
    try {
      resolved = HermesChatAttachmentPolicy.resolve(contentType, name);
    } catch (Exception ignored) {
      addFileCard(bubble, descriptor, null, outgoing);
      return;
    }
    if (!resolved.previewableImage) {
      addFileCard(bubble, descriptor, resolved, outgoing);
      return;
    }
    if (selectedProfile == null || crypto == null || imageCache == null) return;
    String spaceId = selectedProfile.id;
    HermesChatCrypto targetCrypto = crypto;
    HermesChatImageCache imageCache = this.imageCache;
    long generation = profileGeneration;
    TextView loading = text(
      "正在解密图片…",
      12,
      outgoing ? R.color.on_brand : R.color.text_secondary
    );
    LinearLayout.LayoutParams loadingParams = new LinearLayout.LayoutParams(dp(220), dp(42));
    loadingParams.topMargin = dp(6);
    bubble.addView(loading, loadingParams);
    executor.submit(() -> {
      try {
        byte[] ciphertext = imageCache.read(descriptor);
        if (ciphertext == null) {
          ciphertext = api.downloadHermesChatAttachment(spaceId, descriptor.getString("id"));
          imageCache.write(descriptor, ciphertext);
        }
        byte[] plaintext = targetCrypto.decryptAttachment(ciphertext, descriptor);
        Bitmap bitmap = decodeBoundedBitmap(plaintext, 1_024);
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration || selectedProfile == null
              || !spaceId.equals(selectedProfile.id)) return;
          int index = bubble.indexOfChild(loading);
          bubble.removeView(loading);
          ImageView image = new ImageView(this);
          image.setImageBitmap(bitmap);
          image.setScaleType(ImageView.ScaleType.CENTER_CROP);
          image.setContentDescription("点击查看加密聊天图片");
          image.setBackground(rounded(R.color.surface, 12));
          image.setOnClickListener(view -> handleAttachmentTap(
            bubble,
            () -> showImagePreview(descriptor)
          ));
          image.setOnLongClickListener(view -> bubble.performLongClick());
          LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(240), dp(180));
          params.topMargin = dp(6);
          bubble.addView(image, Math.max(0, index), params);
        });
      } catch (Exception error) {
        runOnUiThread(() -> {
          if (!destroyed && generation == profileGeneration) loading.setText("图片解密失败");
        });
      }
    });
  }

  private void addFileCard(
    LinearLayout bubble,
    JSONObject descriptor,
    HermesChatAttachmentPolicy.ResolvedType resolved,
    boolean outgoing
  ) {
    LinearLayout card = vertical();
    card.setPadding(dp(12), dp(10), dp(12), dp(10));
    card.setBackground(rounded(
      outgoing ? R.color.brand_primary_dark : R.color.surface,
      12
    ));
    card.setOnLongClickListener(view -> bubble.performLongClick());
    card.setOnClickListener(view -> {
      if (!selectedMessageIds.isEmpty()) {
        Object tag = bubble.getTag();
        if (tag instanceof RenderedMessage) toggleMessageSelection((RenderedMessage) tag);
      }
    });
    String name = descriptor.optString("name", "Hermes-附件");
    TextView title = text(
      name,
      14,
      outgoing ? R.color.on_brand : R.color.text_primary
    );
    title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    title.setMaxLines(2);
    title.setEllipsize(TextUtils.TruncateAt.MIDDLE);
    card.addView(title, new LinearLayout.LayoutParams(-1, -2));

    String category = resolved == null ? "附件" : resolved.category.label;
    String format = resolved == null ? "FILE" : resolved.extension.toUpperCase(Locale.ROOT);
    long bytes = descriptor.optLong("plaintextBytes", -1);
    TextView detail = text(
      category + " · " + format + " · " + HermesChatAttachmentPolicy.formatBytes(bytes),
      12,
      outgoing ? R.color.on_brand : R.color.text_secondary
    );
    detail.setAlpha(0.82f);
    LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(-1, -2);
    detailParams.topMargin = dp(4);
    card.addView(detail, detailParams);

    LinearLayout actions = horizontal(Gravity.END);
    if (resolved != null && (resolved.category == HermesChatAttachmentPolicy.Category.AUDIO
        || resolved.category == HermesChatAttachmentPolicy.Category.VIDEO)) {
      Button play = attachmentActionButton("播放", outgoing);
      play.setOnClickListener(view -> handleAttachmentTap(
        bubble,
        () -> playAttachment(descriptor, resolved)
      ));
      actions.addView(play, new LinearLayout.LayoutParams(dp(72), dp(48)));
    }
    Button save = attachmentActionButton("保存", outgoing);
    save.setOnClickListener(view -> handleAttachmentTap(
      bubble,
      () -> requestSaveAttachment(descriptor)
    ));
    LinearLayout.LayoutParams saveParams = new LinearLayout.LayoutParams(dp(72), dp(48));
    saveParams.setMarginStart(dp(6));
    actions.addView(save, saveParams);
    LinearLayout.LayoutParams actionsParams = new LinearLayout.LayoutParams(-1, dp(48));
    actionsParams.topMargin = dp(5);
    card.addView(actions, actionsParams);

    LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(dp(260), -2);
    cardParams.topMargin = dp(7);
    bubble.addView(card, cardParams);
  }

  private void handleAttachmentTap(LinearLayout bubble, Runnable action) {
    if (!selectedMessageIds.isEmpty()) {
      Object tag = bubble.getTag();
      if (tag instanceof RenderedMessage) toggleMessageSelection((RenderedMessage) tag);
      return;
    }
    action.run();
  }

  private Button attachmentActionButton(String label, boolean outgoing) {
    Button button = new Button(this);
    button.setText(label);
    button.setTextSize(13);
    button.setAllCaps(false);
    button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    button.setTextColor(getColor(outgoing ? R.color.on_brand : R.color.brand_primary_dark));
    button.setBackground(rounded(
      outgoing ? R.color.brand_primary : R.color.surface_tonal,
      12
    ));
    return button;
  }

  private void requestSaveAttachment(JSONObject descriptor) {
    if (selectedProfile == null || crypto == null || imageCache == null) return;
    try {
      String name = descriptor.optString("name", "Hermes-附件");
      HermesChatAttachmentPolicy.ResolvedType resolved = HermesChatAttachmentPolicy.resolve(
        descriptor.optString("contentType"),
        name
      );
      pendingSaveDescriptor = new JSONObject(descriptor.toString());
      pendingSaveSpaceId = selectedProfile.id;
      Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
      intent.addCategory(Intent.CATEGORY_OPENABLE);
      intent.setType(resolved.contentType);
      intent.putExtra(
        Intent.EXTRA_TITLE,
        HermesChatAttachmentPolicy.safeDisplayName(name, resolved)
      );
      startActivityForResult(intent, REQUEST_SAVE_ATTACHMENT);
    } catch (Exception error) {
      pendingSaveDescriptor = null;
      pendingSaveSpaceId = null;
      toast("无法保存附件：" + error.getMessage());
      focusComposer(true);
    }
  }

  private void saveAttachmentToUri(Uri destination, JSONObject descriptor, String spaceId) {
    HermesChatCrypto targetCrypto = crypto;
    HermesChatImageCache targetCache = imageCache;
    long generation = profileGeneration;
    if (targetCrypto == null || targetCache == null) return;
    showConnectionAwareStatus("正在解密并保存附件…");
    executor.submit(() -> {
      try {
        byte[] plaintext = loadDecryptedAttachment(
          descriptor,
          spaceId,
          targetCrypto,
          targetCache
        );
        try (OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
          if (output == null) throw new IllegalStateException("无法写入所选位置。");
          output.write(plaintext);
        }
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration) return;
          restoreConversationStatus();
          toast("附件已保存到所选位置。");
          focusComposer(true);
        });
      } catch (Exception error) {
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration) return;
          showConnectionAwareStatus("附件保存失败");
          toast(error.getMessage());
          focusComposer(true);
        });
      }
    });
  }

  private void playAttachment(
    JSONObject descriptor,
    HermesChatAttachmentPolicy.ResolvedType resolved
  ) {
    if (selectedProfile == null || crypto == null || imageCache == null) return;
    String spaceId = selectedProfile.id;
    HermesChatCrypto targetCrypto = crypto;
    HermesChatImageCache targetCache = imageCache;
    long generation = profileGeneration;
    showConnectionAwareStatus("正在准备" + resolved.category.label + "播放…");
    executor.submit(() -> {
      File playbackFile = null;
      try {
        byte[] plaintext = loadDecryptedAttachment(
          descriptor,
          spaceId,
          targetCrypto,
          targetCache
        );
        playbackFile = createPlaybackFile(resolved.extension, plaintext);
        File readyFile = playbackFile;
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration || selectedProfile == null
              || !spaceId.equals(selectedProfile.id)) {
            deletePlaybackFile(readyFile);
            return;
          }
          restoreConversationStatus();
          String name = descriptor.optString("name", resolved.category.label);
          if (resolved.category == HermesChatAttachmentPolicy.Category.AUDIO) {
            showAudioPlayer(readyFile, name);
          } else {
            showVideoPlayer(readyFile, name);
          }
        });
      } catch (Exception error) {
        if (playbackFile != null) deletePlaybackFile(playbackFile);
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration) return;
          showConnectionAwareStatus("播放准备失败");
          toast(error.getMessage());
          focusComposer(true);
        });
      }
    });
  }

  private byte[] loadDecryptedAttachment(
    JSONObject descriptor,
    String spaceId,
    HermesChatCrypto targetCrypto,
    HermesChatImageCache targetCache
  ) throws Exception {
    byte[] ciphertext = targetCache.read(descriptor);
    if (ciphertext == null) {
      ciphertext = api.downloadHermesChatAttachment(spaceId, descriptor.getString("id"));
      targetCache.write(descriptor, ciphertext);
    }
    return targetCrypto.decryptAttachment(ciphertext, descriptor);
  }

  private void showAudioPlayer(File file, String name) {
    MediaPlayer player = new MediaPlayer();
    try {
      player.setDataSource(file.getAbsolutePath());
      player.prepare();
    } catch (Exception error) {
      player.release();
      deletePlaybackFile(file);
      toast("音频无法播放：" + error.getMessage());
      focusComposer(true);
      return;
    }

    LinearLayout content = vertical();
    content.setPadding(dp(20), dp(8), dp(20), 0);
    TextView filename = text(name, 15, R.color.text_primary);
    filename.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    filename.setMaxLines(2);
    filename.setEllipsize(TextUtils.TruncateAt.MIDDLE);
    content.addView(filename, new LinearLayout.LayoutParams(-1, -2));
    SeekBar seek = new SeekBar(this);
    seek.setMax(Math.max(1, player.getDuration()));
    LinearLayout.LayoutParams seekParams = new LinearLayout.LayoutParams(-1, dp(48));
    seekParams.topMargin = dp(8);
    content.addView(seek, seekParams);
    LinearLayout controls = horizontal(Gravity.CENTER_VERTICAL);
    Button toggle = new Button(this);
    toggle.setText("暂停");
    toggle.setAllCaps(false);
    toggle.setTextColor(getColor(R.color.on_brand));
    toggle.setBackground(rounded(R.color.brand_primary, 14));
    controls.addView(toggle, new LinearLayout.LayoutParams(dp(88), dp(48)));
    TextView time = text("00:00 / " + formatDuration(player.getDuration()), 13, R.color.text_secondary);
    LinearLayout.LayoutParams timeParams = new LinearLayout.LayoutParams(0, dp(48), 1);
    timeParams.setMarginStart(dp(12));
    controls.addView(time, timeParams);
    content.addView(controls, new LinearLayout.LayoutParams(-1, dp(48)));

    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("播放音频")
      .setView(content)
      .setNegativeButton("关闭", null)
      .create();
    Runnable update = new Runnable() {
      @Override public void run() {
        try {
          int position = player.getCurrentPosition();
          seek.setProgress(position);
          time.setText(formatDuration(position) + " / " + formatDuration(player.getDuration()));
          if (player.isPlaying()) handler.postDelayed(this, 500);
        } catch (IllegalStateException ignored) {
          // The dialog was dismissed while an update was pending.
        }
      }
    };
    toggle.setOnClickListener(view -> {
      if (player.isPlaying()) {
        player.pause();
        toggle.setText("播放");
        handler.removeCallbacks(update);
      } else {
        if (player.getCurrentPosition() >= player.getDuration()) player.seekTo(0);
        player.start();
        toggle.setText("暂停");
        handler.post(update);
      }
    });
    seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
      @Override public void onProgressChanged(SeekBar bar, int value, boolean fromUser) {
        if (fromUser) {
          player.seekTo(value);
          time.setText(formatDuration(value) + " / " + formatDuration(player.getDuration()));
        }
      }
      @Override public void onStartTrackingTouch(SeekBar bar) {}
      @Override public void onStopTrackingTouch(SeekBar bar) {}
    });
    player.setOnCompletionListener(ignored -> {
      toggle.setText("重播");
      seek.setProgress(player.getDuration());
      handler.removeCallbacks(update);
    });
    dialog.setOnDismissListener(ignored -> {
      playbackDialogs.remove(dialog);
      handler.removeCallbacks(update);
      try { player.stop(); } catch (IllegalStateException ignoredState) {}
      player.release();
      deletePlaybackFile(file);
      focusComposer(true);
    });
    playbackDialogs.add(dialog);
    dialog.show();
    player.start();
    handler.post(update);
  }

  private void showVideoPlayer(File file, String name) {
    Dialog dialog = new Dialog(this, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);
    VideoView video = new VideoView(this);
    video.setContentDescription("正在播放 " + name);
    MediaController controller = new MediaController(this);
    controller.setAnchorView(video);
    video.setMediaController(controller);
    video.setVideoPath(file.getAbsolutePath());
    FrameLayout.LayoutParams videoParams = new FrameLayout.LayoutParams(-1, -1);
    videoParams.setMargins(0, dp(56), 0, 0);
    root.addView(video, videoParams);

    LinearLayout top = horizontal(Gravity.CENTER_VERTICAL);
    top.setPadding(dp(8), dp(4), dp(8), dp(4));
    top.setBackgroundColor(0xCC000000);
    Button close = new Button(this);
    close.setText("关闭");
    close.setTextColor(Color.WHITE);
    close.setOnClickListener(view -> dialog.dismiss());
    top.addView(close, new LinearLayout.LayoutParams(dp(76), dp(48)));
    TextView title = text(name, 15, android.R.color.white);
    title.setGravity(Gravity.CENTER);
    title.setSingleLine(true);
    title.setEllipsize(TextUtils.TruncateAt.MIDDLE);
    top.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
    root.addView(top, new FrameLayout.LayoutParams(-1, dp(56), Gravity.TOP));

    dialog.setContentView(root);
    dialog.setOnShowListener(ignored -> {
      if (dialog.getWindow() != null) {
        dialog.getWindow().setBackgroundDrawable(new ColorDrawable(Color.BLACK));
        dialog.getWindow().setLayout(-1, -1);
      }
      video.start();
    });
    video.setOnPreparedListener(player -> {
      player.setLooping(false);
      video.start();
    });
    video.setOnErrorListener((player, what, extra) -> {
      toast("当前设备无法播放此视频编码。");
      dialog.dismiss();
      return true;
    });
    dialog.setOnDismissListener(ignored -> {
      playbackDialogs.remove(dialog);
      video.stopPlayback();
      deletePlaybackFile(file);
      focusComposer(true);
    });
    playbackDialogs.add(dialog);
    dialog.show();
  }

  private File createPlaybackFile(String extension, byte[] plaintext) throws Exception {
    File directory = new File(getCacheDir(), "hermes-chat-playback");
    if (!directory.exists() && !directory.mkdirs()) {
      throw new IllegalStateException("无法创建播放缓存。");
    }
    String suffix = extension == null || !extension.matches("[a-z0-9]{1,8}")
      ? ".bin"
      : "." + extension;
    File file = File.createTempFile("attachment-", suffix, directory);
    try (FileOutputStream output = new FileOutputStream(file)) {
      output.write(plaintext);
      output.getFD().sync();
    } catch (Exception error) {
      file.delete();
      throw error;
    }
    synchronized (playbackFiles) {
      playbackFiles.add(file);
    }
    return file;
  }

  private void deletePlaybackFile(File file) {
    if (file == null) return;
    synchronized (playbackFiles) {
      playbackFiles.remove(file);
    }
    if (file.exists()) file.delete();
  }

  private void cleanupStalePlaybackFiles() {
    File directory = new File(getCacheDir(), "hermes-chat-playback");
    File[] files = directory.listFiles();
    if (files == null) return;
    for (File file : files) if (file.isFile()) file.delete();
  }

  private void cleanupPlaybackFiles() {
    File[] files;
    synchronized (playbackFiles) {
      files = playbackFiles.toArray(new File[0]);
      playbackFiles.clear();
    }
    for (File file : files) if (file.exists()) file.delete();
  }

  private void cleanupPlaybackDialogs() {
    Dialog[] dialogs = playbackDialogs.toArray(new Dialog[0]);
    playbackDialogs.clear();
    for (Dialog dialog : dialogs) {
      if (dialog.isShowing()) dialog.dismiss();
    }
  }

  private static String formatDuration(int milliseconds) {
    int totalSeconds = Math.max(0, milliseconds / 1000);
    return String.format(
      Locale.ROOT,
      "%02d:%02d",
      totalSeconds / 60,
      totalSeconds % 60
    );
  }

  private void restoreConversationStatus() {
    showConnectionAwareStatus(awaitingAgentResponse ? "正在思考…" : "已加密");
  }

  private void showImagePreview(JSONObject descriptor) {
    if (selectedProfile == null || crypto == null || imageCache == null) return;
    String spaceId = selectedProfile.id;
    HermesChatCrypto targetCrypto = crypto;
    HermesChatImageCache targetImages = imageCache;
    long generation = profileGeneration;
    showConnectionAwareStatus("正在打开大图…");
    executor.submit(() -> {
      try {
        byte[] plaintext = loadDecryptedAttachment(
          descriptor,
          spaceId,
          targetCrypto,
          targetImages
        );
        Bitmap bitmap = decodeBoundedBitmap(plaintext, 2_048);
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration || selectedProfile == null
              || !spaceId.equals(selectedProfile.id)) return;
          showConnectionAwareStatus(
            awaitingAgentResponse ? "正在思考…" : "已加密"
          );
          showImagePreview(bitmap, plaintext, descriptor);
        });
      } catch (Exception error) {
        runOnUiThread(() -> {
          if (!destroyed && generation == profileGeneration) {
            showConnectionAwareStatus("图片打开失败");
            toast(error.getMessage());
          }
        });
      }
    });
  }

  private void showImagePreview(Bitmap bitmap, byte[] plaintext, JSONObject descriptor) {
    Dialog dialog = new Dialog(this, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);

    ImageView image = new ImageView(this);
    image.setImageBitmap(bitmap);
    image.setScaleType(ImageView.ScaleType.FIT_CENTER);
    image.setAdjustViewBounds(true);
    image.setContentDescription("聊天图片大图预览");
    FrameLayout.LayoutParams imageParams = new FrameLayout.LayoutParams(-1, -1);
    imageParams.setMargins(0, dp(56), 0, 0);
    root.addView(image, imageParams);

    LinearLayout actions = horizontal(Gravity.CENTER_VERTICAL);
    actions.setPadding(dp(8), dp(6), dp(8), dp(6));
    actions.setBackgroundColor(0xCC000000);
    Button close = new Button(this);
    close.setText("关闭");
    close.setTextColor(Color.WHITE);
    close.setOnClickListener(view -> dialog.dismiss());
    actions.addView(close, new LinearLayout.LayoutParams(dp(76), dp(48)));
    TextView title = text("加密聊天图片", 16, android.R.color.white);
    title.setGravity(Gravity.CENTER);
    actions.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
    Button save = new Button(this);
    save.setText("保存相册");
    save.setTextColor(Color.WHITE);
    save.setOnClickListener(view -> saveImageToGallery(plaintext, descriptor));
    actions.addView(save, new LinearLayout.LayoutParams(dp(104), dp(48)));
    root.addView(actions, new FrameLayout.LayoutParams(-1, dp(60), Gravity.TOP));

    dialog.setContentView(root);
    dialog.setOnShowListener(ignored -> {
      if (dialog.getWindow() != null) {
        dialog.getWindow().setBackgroundDrawable(new ColorDrawable(Color.BLACK));
        dialog.getWindow().setLayout(-1, -1);
      }
    });
    dialog.setOnDismissListener(ignored -> focusComposer(true));
    dialog.show();
  }

  private void saveImageToGallery(byte[] plaintext, JSONObject descriptor) {
    executor.submit(() -> {
      Uri destination = null;
      try {
        String contentType = descriptor.getString("contentType");
        if (!contentType.startsWith("image/")) throw new IllegalArgumentException("不是有效图片。");
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, galleryFilename(
          descriptor.optString("name", "Hermes-image"),
          contentType
        ));
        values.put(MediaStore.MediaColumns.MIME_TYPE, contentType);
        values.put(
          MediaStore.MediaColumns.RELATIVE_PATH,
          Environment.DIRECTORY_PICTURES + "/My Notes"
        );
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        destination = getContentResolver().insert(
          MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
          values
        );
        if (destination == null) throw new IllegalStateException("无法创建相册图片。");
        try (OutputStream output = getContentResolver().openOutputStream(destination, "w")) {
          if (output == null) throw new IllegalStateException("无法写入相册图片。");
          output.write(plaintext);
        }
        ContentValues published = new ContentValues();
        published.put(MediaStore.MediaColumns.IS_PENDING, 0);
        getContentResolver().update(destination, published, null, null);
        runOnUiThread(() -> toast("图片已保存到“图片/My Notes”。"));
      } catch (Exception error) {
        if (destination != null) getContentResolver().delete(destination, null, null);
        runOnUiThread(() -> toast("保存图片失败：" + error.getMessage()));
      }
    });
  }

  private static Bitmap decodeBoundedBitmap(byte[] data, int maximumDimension) {
    BitmapFactory.Options bounds = new BitmapFactory.Options();
    bounds.inJustDecodeBounds = true;
    BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
    if (bounds.outWidth < 1 || bounds.outHeight < 1) {
      throw new IllegalArgumentException("图片格式无法显示。");
    }
    int sample = 1;
    while (Math.max(bounds.outWidth / sample, bounds.outHeight / sample) > maximumDimension) {
      sample *= 2;
    }
    BitmapFactory.Options options = new BitmapFactory.Options();
    options.inSampleSize = sample;
    options.inPreferredConfig = Bitmap.Config.ARGB_8888;
    Bitmap bitmap = BitmapFactory.decodeByteArray(data, 0, data.length, options);
    if (bitmap == null) throw new IllegalArgumentException("图片格式无法显示。");
    return bitmap;
  }

  private static String galleryFilename(String value, String contentType) {
    String filename = value == null ? "Hermes-image" : value;
    filename = filename.replaceAll("[^\\p{L}\\p{N}._ -]", "_")
      .replaceAll("^[ .]+|[ .]+$", "");
    if (filename.isEmpty()) filename = "Hermes-image";
    if (!filename.contains(".")) {
      if ("image/jpeg".equals(contentType)) filename += ".jpg";
      else if ("image/webp".equals(contentType)) filename += ".webp";
      else if ("image/gif".equals(contentType)) filename += ".gif";
      else filename += ".png";
    }
    return filename.length() > 120 ? filename.substring(0, 120) : filename;
  }

  private void showSettings(View anchor) {
    if (selectedProfile == null) {
      toast("请先选择 Hermes 聊天对象。");
      return;
    }
    PopupMenu menu = new PopupMenu(this, anchor);
    menu.getMenu().add(0, 1, 0, "查看并复制聊天密钥").setIcon(R.drawable.ic_key);
    menu.getMenu().add(0, 2, 1, "替换聊天密钥").setIcon(R.drawable.ic_refresh);
    menu.getMenu().add(
      0,
      3,
      2,
      "聊天缓存保留时间：" + retentionLabel(HermesChatCacheSettings.retentionDays(this))
    );
    menu.getMenu().add(0, 4, 3, "清理当前聊天（本机和 Cloudflare）");
    menu.setForceShowIcon(true);
    menu.setOnMenuItemClickListener(item -> {
      if (item.getItemId() == 1) {
        showKeyCopy(secureStore.loadHermesChatKey(selectedProfile.id));
      }
      else if (item.getItemId() == 2) showKeySetup(true);
      else if (item.getItemId() == 3) showCacheRetentionDialog();
      else if (item.getItemId() == 4) confirmClearChatCache();
      return true;
    });
    menu.show();
  }

  private void showCacheRetentionDialog() {
    int[] values = {7, 30, 90, 0};
    String[] labels = {"7 天", "30 天（推荐）", "90 天", "永久保留"};
    int current = HermesChatCacheSettings.retentionDays(this);
    int selected = 0;
    for (int index = 0; index < values.length; index++) {
      if (values[index] == current) selected = index;
    }
    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("聊天缓存保留时间")
      .setSingleChoiceItems(labels, selected, null)
      .setPositiveButton("保存", null)
      .setNegativeButton("取消", null)
      .create();
    dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
      .setOnClickListener(view -> {
        int choice = dialog.getListView().getCheckedItemPosition();
        if (choice < 0 || choice >= values.length) return;
        HermesChatCacheSettings.setRetentionDays(this, values[choice]);
        dialog.dismiss();
        cleanupCurrentHistory(true);
      }));
    dialog.show();
  }

  private void confirmClearChatCache() {
    new AlertDialog.Builder(this)
      .setTitle("清理当前聊天的全部缓存？")
      .setMessage(
        "会删除当前聊天对象在本机以及 Cloudflare 上的历史消息和加密附件，无法恢复。"
          + "同步序号会保留，重连时不会重新下载这些旧消息。"
      )
      .setPositiveButton("同时清理", (dialog, which) -> clearCurrentHistoryAndCloud())
      .setNegativeButton("取消", null)
      .show();
  }

  private void cleanupCurrentHistory(boolean showResult) {
    HermesChatHistoryStore targetHistory = historyStore;
    HermesChatImageCache targetImages = imageCache;
    long generation = profileGeneration;
    if (targetHistory == null || targetImages == null) return;
    executor.submit(() -> {
      HermesChatHistoryStore.Snapshot snapshot = targetHistory.loadAndCleanup(
        HermesChatCacheSettings.retentionDays(this),
        System.currentTimeMillis()
      );
      targetImages.retain(snapshot.messages);
      runOnUiThread(() -> {
        if (destroyed || generation != profileGeneration || historyStore != targetHistory) return;
        renderCachedMessages(snapshot);
        if (showResult) toast("聊天缓存保留策略已更新。");
      });
    });
  }

  private void clearCurrentHistoryAndCloud() {
    HermesChatHistoryStore targetHistory = historyStore;
    HermesChatImageCache targetImages = imageCache;
    Models.HermesChatProfile targetProfile = selectedProfile;
    long generation = profileGeneration;
    if (targetHistory == null || targetImages == null || targetProfile == null) return;
    String spaceId = targetProfile.id;
    showConnectionAwareStatus("正在清理本机和 Cloudflare 聊天数据…");
    sendButton.setEnabled(false);
    executor.submit(() -> {
      try {
        JSONObject cloud = api.purgeHermesChatCloudData(spaceId);
        HermesChatHistoryStore.Snapshot snapshot = targetHistory.clearMessages();
        targetImages.clear();
        int cloudMessages = cloud.optInt("messagesDeleted");
        int cloudAttachments = cloud.optInt("attachmentsDeleted");
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration || historyStore != targetHistory) return;
          renderCachedMessages(snapshot);
          showConnectionAwareStatus("本机和云端已清理");
          sendButton.setEnabled(connection.isReady());
          toast(
            "清理完成：Cloudflare 消息 " + cloudMessages
              + " 条，附件 " + cloudAttachments + " 个。"
          );
        });
      } catch (Exception error) {
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration) return;
          showConnectionAwareStatus("云端清理失败，本机数据未删除");
          sendButton.setEnabled(connection.isReady());
          toast(error.getMessage());
        });
      }
    });
  }

  private static String retentionLabel(int days) {
    return days <= 0 ? "永久" : days + " 天";
  }

  private void showKeySetup(boolean replacing) {
    if (selectedProfile == null) return;
    String spaceId = selectedProfile.id;
    String profileLabel = selectedProfile.label;
    EditText field = new EditText(this);
    field.setHint("Base64URL 32 字节密钥");
    field.setSingleLine(true);
    field.setText(replacing ? secureStore.loadHermesChatKey(spaceId) : "");
    field.setPadding(dp(16), dp(8), dp(16), dp(8));
    LinearLayout wrapper = vertical();
    wrapper.setPadding(dp(24), dp(8), dp(24), 0);
    TextView explanation = text(
      "“" + profileLabel + "”使用独立密钥。密钥只保存在 Android Keystore 保护的本地存储中，并需配置到对应 NAS profile 的 HERMES_CF_CHAT_KEY。",
      13,
      R.color.text_secondary
    );
    wrapper.addView(explanation, new LinearLayout.LayoutParams(-1, -2));
    LinearLayout.LayoutParams fieldParams = new LinearLayout.LayoutParams(-1, dp(52));
    fieldParams.topMargin = dp(12);
    wrapper.addView(field, fieldParams);

    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle(replacing ? "替换“" + profileLabel + "”密钥" : "设置“" + profileLabel + "”密钥")
      .setView(wrapper)
      .setPositiveButton("保存", null)
      .setNeutralButton("生成新密钥", null)
      .setNegativeButton(replacing ? "取消" : "稍后", null)
      .create();
    dialog.setOnShowListener(ignored -> {
      dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(view -> {
        field.setText(HermesChatCrypto.generateKey());
        field.setSelection(field.length());
      });
      dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
        String value = field.getText().toString().trim();
        try {
          new HermesChatCrypto(value);
          if (selectedProfile == null || !spaceId.equals(selectedProfile.id)) {
            dialog.dismiss();
            return;
          }
          secureStore.saveHermesChatKey(spaceId, value);
          dialog.dismiss();
          showKeyCopy(value);
          startWithKey(value);
        } catch (Exception error) {
          field.setError(error.getMessage());
        }
      });
    });
    dialog.show();
  }

  private void showKeyCopy(String key) {
    if (key == null || key.isEmpty()) {
      showKeySetup(false);
      return;
    }
    TextView value = text(key, 13, R.color.text_primary);
    value.setTextIsSelectable(true);
    value.setPadding(dp(24), dp(8), dp(24), dp(8));
    new AlertDialog.Builder(this)
      .setTitle(selectedProfile == null ? "NAS 聊天密钥" : selectedProfile.label + " · NAS 聊天密钥")
      .setMessage(
        "对应 NAS profile 需设置 HERMES_CF_SPACE_ID="
          + (selectedProfile == null ? "" : selectedProfile.id)
          + "，并将此值设为 HERMES_CF_CHAT_KEY。剪贴板中的密钥属于敏感信息。"
      )
      .setView(value)
      .setPositiveButton("复制", (dialog, which) -> {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(ClipData.newPlainText("Hermes chat key", key));
        toast("聊天密钥已复制，请配置 NAS 后清理剪贴板。");
      })
      .setNegativeButton("关闭", null)
      .show();
  }

  private byte[] readBounded(Uri uri, int maximum) throws Exception {
    try (InputStream input = getContentResolver().openInputStream(uri)) {
      if (input == null) throw new IllegalArgumentException("无法读取附件。");
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      byte[] buffer = new byte[16 * 1024];
      int count;
      while ((count = input.read(buffer)) != -1) {
        if (output.size() + count > maximum) {
          throw new IllegalArgumentException("附件超过 10 MiB 限制。");
        }
        output.write(buffer, 0, count);
      }
      return output.toByteArray();
    }
  }

  private String displayName(Uri uri) {
    try (android.database.Cursor cursor = getContentResolver().query(
      uri,
      new String[] { OpenableColumns.DISPLAY_NAME },
      null,
      null,
      null
    )) {
      if (cursor != null && cursor.moveToFirst()) {
        String name = cursor.getString(0);
        if (name != null && !name.trim().isEmpty()) return name;
      }
    } catch (Exception ignored) {
      // The authenticated attachment id is authoritative; a display name is optional.
    }
    return "Hermes-附件";
  }

  private long displaySize(Uri uri) {
    try (android.database.Cursor cursor = getContentResolver().query(
      uri,
      new String[] { OpenableColumns.SIZE },
      null,
      null,
      null
    )) {
      if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
        return cursor.getLong(0);
      }
    } catch (Exception ignored) {
      // Providers may omit a size; the bounded stream read still enforces the hard limit.
    }
    return -1;
  }

  private void focusComposer(boolean showKeyboard) {
    if (!resumed || destroyed || composer == null || !selectedMessageIds.isEmpty()) return;
    composer.post(() -> {
      if (!resumed || destroyed || !selectedMessageIds.isEmpty()
          || !composer.isAttachedToWindow()) return;
      composer.requestFocus();
      composer.setSelection(composer.length());
      if (showKeyboard) {
        android.view.WindowInsetsController controller = getWindow().getInsetsController();
        if (controller != null) controller.show(WindowInsets.Type.ime());
      }
    });
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
    button.setBackground(rounded(R.color.background, 16));
    return button;
  }

  private FrameLayout chatAvatar() {
    FrameLayout avatar = new FrameLayout(this);
    GradientDrawable background = new GradientDrawable();
    background.setShape(GradientDrawable.OVAL);
    background.setColor(getColor(R.color.surface_tonal));
    avatar.setBackground(background);
    ImageView icon = new ImageView(this);
    icon.setImageResource(R.drawable.ic_chat);
    icon.setImageTintList(ColorStateList.valueOf(getColor(R.color.brand_primary_dark)));
    icon.setPadding(dp(10), dp(10), dp(10), dp(10));
    icon.setContentDescription(null);
    avatar.addView(icon, new FrameLayout.LayoutParams(-1, -1));
    return avatar;
  }

  private GradientDrawable rounded(int color, int radius) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setColor(getColor(color));
    drawable.setCornerRadius(dp(radius));
    return drawable;
  }

  private GradientDrawable roundedStroke(
    int color,
    int strokeColor,
    int radius,
    int strokeWidth
  ) {
    GradientDrawable drawable = rounded(color, radius);
    drawable.setStroke(dp(strokeWidth), getColor(strokeColor));
    return drawable;
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private void toast(String value) {
    Toast.makeText(this, value == null ? "操作失败。" : value, Toast.LENGTH_LONG).show();
  }
}
