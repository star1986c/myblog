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
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
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
  private static final int REQUEST_IMAGE = 2201;
  private static final long AWAITING_RESPONSE_TIMEOUT_MS = 120_000L;
  private static final DateTimeFormatter MESSAGE_TIME_FORMATTER = DateTimeFormatter.ofPattern(
    "yyyy-MM-dd HH:mm",
    Locale.ROOT
  );

  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final Set<String> renderedMessageIds = new HashSet<>();
  private final Map<Long, RenderedMessage> renderedMessagesBySequence = new HashMap<>();

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
  private EditText composer;
  private Button sendButton;
  private LinearLayout pendingImageBar;
  private TextView pendingImageLabel;
  private Uri pendingImageUri;
  private String requestedProfileId;
  private boolean demoMode;
  private boolean webSocketReady;
  private boolean awaitingAgentResponse;
  private boolean destroyed;
  private Models.HermesChatProfile selectedProfile;
  private volatile long profileGeneration;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().setNavigationBarContrastEnforced(false);
    demoMode = (getApplicationInfo().flags
      & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
      && getIntent().getBooleanExtra("demo", false);
    api = new NotesApiClient(this);
    secureStore = new SecureSessionStore(this);
    connection = HermesChatConnectionManager.get(this);
    requestedProfileId = getIntent().getStringExtra(EXTRA_PROFILE_ID);
    if (!demoMode) HermesChatCleanupService.schedule(this);
    buildScreen();
    String requestedLabel = getIntent().getStringExtra(EXTRA_PROFILE_LABEL);
    if (requestedLabel != null && !requestedLabel.trim().isEmpty()) {
      chatTitle.setText(requestedLabel.trim());
    }
    if (demoMode) loadDemoConversation(requestedLabel);
    else loadProfiles();
  }

  @Override
  protected void onDestroy() {
    destroyed = true;
    handler.removeCallbacksAndMessages(null);
    if (connectionListener != null) connection.detach(connectionListener);
    executor.shutdownNow();
    super.onDestroy();
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != REQUEST_IMAGE || resultCode != RESULT_OK || data == null) return;
    Uri uri = data.getData();
    if (uri == null) return;
    stageImage(uri);
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
    column.addView(top, new LinearLayout.LayoutParams(-1, -2));

    TextView privacy = text(
      "消息和图片端到端加密，本机加密缓存默认保留 30 天。",
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
    pendingImageBar = horizontal(Gravity.CENTER_VERTICAL);
    pendingImageBar.setPadding(dp(12), dp(7), dp(8), dp(7));
    pendingImageBar.setBackground(rounded(R.color.surface_tonal, 14));
    pendingImageBar.setVisibility(View.GONE);
    pendingImageLabel = text("", 13, R.color.text_primary);
    pendingImageBar.addView(pendingImageLabel, new LinearLayout.LayoutParams(0, dp(36), 1));
    Button removeImage = new Button(this);
    removeImage.setText("移除");
    removeImage.setTextSize(12);
    removeImage.setTextColor(getColor(R.color.danger));
    removeImage.setAllCaps(false);
    removeImage.setBackground(rounded(R.color.background, 12));
    removeImage.setOnClickListener(view -> clearPendingImage());
    pendingImageBar.addView(removeImage, new LinearLayout.LayoutParams(dp(64), dp(36)));
    LinearLayout.LayoutParams pendingParams = new LinearLayout.LayoutParams(-1, -2);
    pendingParams.setMargins(0, 0, 0, dp(8));
    composePanel.addView(pendingImageBar, pendingParams);

    LinearLayout compose = horizontal(Gravity.BOTTOM);
    ImageButton image = iconButton(R.drawable.ic_image_add, "发送图片");
    image.setOnClickListener(view -> chooseImage());
    compose.addView(image, new LinearLayout.LayoutParams(dp(48), dp(48)));
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
      "你好，我是这个 profile 的独立 Hermes 助手。消息、图片和本机缓存都按聊天对象隔离。",
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
    messages.removeAllViews();
    composer.setText("");
    clearPendingImage();
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

  private void sendCurrentMessage() {
    if (pendingImageUri != null) sendImage(pendingImageUri);
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
    } catch (Exception error) {
      toast(error.getMessage());
    }
  }

  private void chooseImage() {
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType("image/*");
    startActivityForResult(intent, REQUEST_IMAGE);
  }

  private void stageImage(Uri uri) {
    pendingImageUri = uri;
    pendingImageLabel.setText(displayName(uri) + " · 可输入说明文字后发送");
    pendingImageBar.setVisibility(View.VISIBLE);
    showConnectionAwareStatus("图片已添加，点击发送后才会上传");
    composer.requestFocus();
    composer.post(() -> {
      android.view.WindowInsetsController controller = getWindow().getInsetsController();
      if (controller != null) controller.show(WindowInsets.Type.ime());
    });
  }

  private void clearPendingImage() {
    pendingImageUri = null;
    if (pendingImageLabel != null) pendingImageLabel.setText("");
    if (pendingImageBar != null) pendingImageBar.setVisibility(View.GONE);
  }

  private void sendImage(Uri uri) {
    if (!connection.isReady() || selectedProfile == null) {
      toast("请等待 Hermes 连接成功后再发送图片。");
      return;
    }
    String spaceId = selectedProfile.id;
    HermesChatCrypto targetCrypto = crypto;
    HermesChatConnectionManager targetConnection = connection;
    long generation = profileGeneration;
    showConnectionAwareStatus("正在加密并上传图片…");
    String caption = composer.getText().toString().trim();
    sendButton.setEnabled(false);
    executor.submit(() -> {
      try {
        byte[] data = readBounded(uri, HermesChatCrypto.MAX_ATTACHMENT_BYTES);
        String contentType = getContentResolver().getType(uri);
        if (contentType == null || !contentType.startsWith("image/")) {
          throw new IllegalArgumentException("请选择有效图片。");
        }
        HermesChatCrypto.EncryptedAttachment encrypted = targetCrypto.encryptAttachment(
          data,
          contentType,
          displayName(uri)
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
          if (uri.equals(pendingImageUri)) clearPendingImage();
          appendMessage(message);
          markAwaitingAgentResponse();
          sendButton.setEnabled(true);
        });
      } catch (Exception error) {
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration) return;
          toast(error.getMessage());
          showConnectionAwareStatus("图片发送失败");
          sendButton.setEnabled(connection.isReady());
        });
      }
    });
  }

  private void renderCachedMessages(HermesChatHistoryStore.Snapshot snapshot) {
    renderedMessageIds.clear();
    renderedMessagesBySequence.clear();
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
    TextView body = text(
      message.text,
      16,
      outgoing ? R.color.on_brand : R.color.text_primary
    );
    int maximumWidth = (int) (getResources().getDisplayMetrics().widthPixels * 0.82f);
    body.setMaxWidth(Math.min(maximumWidth, dp(520)));
    body.setTextIsSelectable(true);
    body.setVisibility(message.text.trim().isEmpty() ? View.GONE : View.VISIBLE);
    bubble.addView(body, new LinearLayout.LayoutParams(-2, -2));
    for (int index = 0; index < message.attachments.length(); index++) {
      JSONObject descriptor = message.attachments.optJSONObject(index);
      if (descriptor != null) addAttachmentPreview(bubble, descriptor);
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
    if (message.sequence > 0) {
      renderedMessagesBySequence.put(
        message.sequence,
        new RenderedMessage(body, meta, message.sentAt)
      );
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
    body.setText(message.text);
    body.setVisibility(message.text.trim().isEmpty() ? View.GONE : View.VISIBLE);
    String sentTime = formatMessageTime(rendered.sentAt);
    rendered.meta.setText(message.finalUpdate ? sentTime : sentTime + " · 正在回复");
    messageScroll.post(() -> messageScroll.fullScroll(View.FOCUS_DOWN));
  }

  private static String formatMessageTime(long sentAt) {
    if (sentAt <= 0) return "时间未知";
    return MESSAGE_TIME_FORMATTER.format(
      Instant.ofEpochMilli(sentAt).atZone(ZoneId.systemDefault())
    );
  }

  private static final class RenderedMessage {
    final TextView body;
    final TextView meta;
    final long sentAt;

    RenderedMessage(TextView body, TextView meta, long sentAt) {
      this.body = body;
      this.meta = meta;
      this.sentAt = sentAt;
    }
  }

  private void addAttachmentPreview(LinearLayout bubble, JSONObject descriptor) {
    if (selectedProfile == null || crypto == null || imageCache == null) return;
    String spaceId = selectedProfile.id;
    HermesChatCrypto targetCrypto = crypto;
    HermesChatImageCache imageCache = this.imageCache;
    long generation = profileGeneration;
    TextView loading = text("正在解密图片…", 12, R.color.text_secondary);
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
          image.setContentDescription("点击查看加密聊天大图");
          image.setBackground(rounded(R.color.surface, 12));
          image.setOnClickListener(view -> showImagePreview(descriptor));
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

  private void showImagePreview(JSONObject descriptor) {
    if (selectedProfile == null || crypto == null || imageCache == null) return;
    String spaceId = selectedProfile.id;
    HermesChatCrypto targetCrypto = crypto;
    HermesChatImageCache targetImages = imageCache;
    long generation = profileGeneration;
    showConnectionAwareStatus("正在打开大图…");
    executor.submit(() -> {
      try {
        byte[] ciphertext = targetImages.read(descriptor);
        if (ciphertext == null) {
          ciphertext = api.downloadHermesChatAttachment(spaceId, descriptor.getString("id"));
          targetImages.write(descriptor, ciphertext);
        }
        byte[] plaintext = targetCrypto.decryptAttachment(ciphertext, descriptor);
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
        "会删除当前聊天对象在本机以及 Cloudflare 上的历史消息和加密图片附件，无法恢复。"
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
      if (input == null) throw new IllegalArgumentException("无法读取图片。");
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      byte[] buffer = new byte[16 * 1024];
      int count;
      while ((count = input.read(buffer)) != -1) {
        if (output.size() + count > maximum) throw new IllegalArgumentException("图片超过 10 MiB 限制。");
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
    return "image";
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
