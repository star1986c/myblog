package io.qzz.superstar1014.mynotes;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.text.Editable;
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
import java.util.HashSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class HermesChatActivity extends Activity implements HermesChatClient.Listener {
  private static final int REQUEST_IMAGE = 2201;

  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final Set<String> renderedMessageIds = new HashSet<>();
  private final Map<Long, RenderedMessage> renderedMessagesBySequence = new HashMap<>();

  private NotesApiClient api;
  private SecureSessionStore secureStore;
  private HermesChatCrypto crypto;
  private HermesChatClient client;
  private LinearLayout messages;
  private ScrollView messageScroll;
  private TextView chatTitle;
  private TextView status;
  private EditText composer;
  private Button sendButton;
  private LinearLayout pendingImageBar;
  private TextView pendingImageLabel;
  private Uri pendingImageUri;
  private int reconnectAttempt;
  private boolean destroyed;
  private Models.HermesChatProfile selectedProfile;
  private volatile long profileGeneration;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().setNavigationBarContrastEnforced(false);
    api = new NotesApiClient(this);
    secureStore = new SecureSessionStore(this);
    buildScreen();
    loadProfiles();
  }

  @Override
  protected void onDestroy() {
    destroyed = true;
    handler.removeCallbacksAndMessages(null);
    if (client != null) client.shutdown();
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
      reconnectAttempt = 0;
      status.setText("已连接 · 端到端加密");
      status.setTextColor(getColor(R.color.brand_primary_dark));
      sendButton.setEnabled(true);
    });
  }

  @Override
  public void onMessage(HermesChatCrypto.ChatMessage message) {
    runOnUiThread(() -> {
      status.setText("已连接 · 端到端加密");
      appendMessage(message);
    });
  }

  @Override
  public void onAcknowledged(String messageId, long sequence) {
    // The local bubble is already visible. Sequence acknowledgements are used for relay deduplication.
  }

  @Override
  public void onTyping(boolean active) {
    runOnUiThread(() -> {
      if (!active) return;
      status.setText("Hermes 正在思考…");
      handler.removeCallbacks(clearTyping);
      handler.postDelayed(clearTyping, 6_000);
    });
  }

  @Override
  public void onDisconnected(String reason) {
    runOnUiThread(() -> {
      status.setText("连接断开，正在重试…");
      status.setTextColor(getColor(R.color.warning));
      sendButton.setEnabled(false);
      scheduleReconnect();
      if (reason != null && reason.contains("401")) toast("聊天授权已过期，正在重新认证。");
    });
  }

  private final Runnable clearTyping = () -> {
    if (client != null && client.isConnected()) status.setText("已连接 · 端到端加密");
  };

  private void buildScreen() {
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(getColor(R.color.background));
    LinearLayout column = vertical();
    root.addView(column, new FrameLayout.LayoutParams(-1, -1));

    LinearLayout top = horizontal(Gravity.CENTER_VERTICAL);
    top.setPadding(dp(8), dp(8), dp(8), dp(8));
    ImageButton back = iconButton(R.drawable.ic_arrow_back, "返回笔记");
    back.setOnClickListener(view -> finish());
    top.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));

    LinearLayout heading = vertical();
    chatTitle = text("Hermes", 19, R.color.text_primary);
    chatTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    heading.addView(chatTitle);
    status = text("正在准备安全连接…", 12, R.color.text_secondary);
    heading.addView(status);
    LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(0, dp(52), 1);
    headingParams.setMarginStart(dp(8));
    top.addView(heading, headingParams);

    ImageButton reconnect = iconButton(R.drawable.ic_refresh, "重新连接");
    reconnect.setOnClickListener(view -> authenticateAndConnect());
    top.addView(reconnect, new LinearLayout.LayoutParams(dp(48), dp(48)));
    ImageButton settings = iconButton(R.drawable.ic_key, "聊天密钥设置");
    settings.setOnClickListener(this::showSettings);
    top.addView(settings, new LinearLayout.LayoutParams(dp(48), dp(48)));
    column.addView(top, new LinearLayout.LayoutParams(-1, dp(68)));

    TextView privacy = text("消息和图片在手机与 NAS 之间加密，Cloudflare 只保存密文。", 12, R.color.text_secondary);
    privacy.setGravity(Gravity.CENTER);
    privacy.setPadding(dp(16), dp(6), dp(16), dp(8));
    column.addView(privacy, new LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT));

    messageScroll = new ScrollView(this);
    messageScroll.setFillViewport(true);
    messages = vertical();
    messages.setPadding(dp(12), dp(8), dp(12), dp(8));
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
    composer.setBackground(rounded(R.color.background, 18));
    composer.addTextChangedListener(new TextWatcher() {
      @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
      @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
        if (client != null && client.isConnected()) client.sendTyping(s.length() > 0);
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
    status.setText("正在加载 Hermes 聊天对象…");
    executor.submit(() -> {
      try {
        NotesApiClient.SessionResult session = api.restoreSession();
        if (!session.authenticated) throw new IllegalStateException("请先在 My Notes 登录。");
        List<Models.HermesChatProfile> profiles = api.hermesChatProfiles();
        if (profiles.isEmpty()) throw new IllegalStateException("尚未配置 Hermes profile。");
        runOnUiThread(() -> {
          if (destroyed) return;
          selectProfile(profiles.get(0));
        });
      } catch (Exception error) {
        runOnUiThread(() -> {
          status.setText("无法加载 Hermes 聊天对象");
          toast(error.getMessage());
        });
      }
    });
  }

  private void selectProfile(Models.HermesChatProfile profile) {
    if (destroyed) return;
    profileGeneration += 1;
    handler.removeCallbacksAndMessages(null);
    if (client != null) {
      client.shutdown();
      client = null;
    }
    selectedProfile = profile;
    crypto = null;
    reconnectAttempt = 0;
    renderedMessageIds.clear();
    renderedMessagesBySequence.clear();
    messages.removeAllViews();
    composer.setText("");
    clearPendingImage();
    sendButton.setEnabled(false);
    chatTitle.setText(profile.label);
    status.setText("正在准备独立加密会话…");
    String key = secureStore.loadHermesChatKey(profile.id);
    if (key.isEmpty()) showKeySetup(false);
    else startWithKey(key);
  }

  private void startWithKey(String encodedKey) {
    if (selectedProfile == null) return;
    try {
      crypto = new HermesChatCrypto(encodedKey);
      if (client != null) client.shutdown();
      long generation = profileGeneration;
      client = new HermesChatClient(crypto, scopedListener(generation));
      authenticateAndConnect();
    } catch (Exception error) {
      secureStore.clearHermesChatKey(selectedProfile.id);
      toast(error.getMessage());
      showKeySetup(false);
    }
  }

  private HermesChatClient.Listener scopedListener(long generation) {
    return new HermesChatClient.Listener() {
      private boolean active() {
        return !destroyed && generation == profileGeneration;
      }

      @Override public void onReady() {
        if (active()) HermesChatActivity.this.onReady();
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

  private void authenticateAndConnect() {
    if (destroyed || crypto == null || selectedProfile == null || client == null) return;
    String spaceId = selectedProfile.id;
    HermesChatClient targetClient = client;
    long generation = profileGeneration;
    status.setText("正在获取短期连接凭证…");
    status.setTextColor(getColor(R.color.text_secondary));
    sendButton.setEnabled(false);
    executor.submit(() -> {
      try {
        NotesApiClient.SessionResult session = api.restoreSession();
        if (!session.authenticated) throw new IllegalStateException("请先在 My Notes 登录。 ");
        Models.HermesChatTicket ticket = api.hermesChatTicket(spaceId);
        runOnUiThread(() -> {
          if (!destroyed && generation == profileGeneration
              && selectedProfile != null && spaceId.equals(selectedProfile.id)
              && client == targetClient) {
            targetClient.connect(ticket);
          }
        });
      } catch (Exception error) {
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration) return;
          status.setText("无法连接 Hermes");
          toast(error.getMessage());
          scheduleReconnect();
        });
      }
    });
  }

  private void scheduleReconnect() {
    if (destroyed || crypto == null) return;
    handler.removeCallbacks(reconnect);
    long delay = Math.min(30_000L, 2_000L << Math.min(reconnectAttempt, 4));
    reconnectAttempt += 1;
    handler.postDelayed(reconnect, delay);
  }

  private final Runnable reconnect = this::authenticateAndConnect;

  private void sendCurrentMessage() {
    if (pendingImageUri != null) sendImage(pendingImageUri);
    else sendText();
  }

  private void sendText() {
    String value = composer.getText().toString().trim();
    if (value.isEmpty()) return;
    try {
      HermesChatCrypto.ChatMessage message = client.sendMessage(value, new JSONArray());
      composer.setText("");
      appendMessage(message);
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
    status.setText("图片已添加，点击发送后才会上传");
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
    if (client == null || !client.isConnected() || selectedProfile == null) {
      toast("请等待 Hermes 连接成功后再发送图片。");
      return;
    }
    String spaceId = selectedProfile.id;
    HermesChatCrypto targetCrypto = crypto;
    HermesChatClient targetClient = client;
    long generation = profileGeneration;
    status.setText("正在加密并上传图片…");
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
        JSONArray attachments = new JSONArray().put(encrypted.descriptor);
        HermesChatCrypto.ChatMessage message = targetClient.sendMessage(caption, attachments);
        runOnUiThread(() -> {
          if (generation != profileGeneration || selectedProfile == null
              || !spaceId.equals(selectedProfile.id)
              || client != targetClient) return;
          composer.setText("");
          if (uri.equals(pendingImageUri)) clearPendingImage();
          appendMessage(message);
          status.setText("已连接 · 端到端加密");
          sendButton.setEnabled(true);
        });
      } catch (Exception error) {
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration) return;
          toast(error.getMessage());
          status.setText("图片发送失败");
          sendButton.setEnabled(client != null && client.isConnected());
        });
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
    body.setTextIsSelectable(true);
    body.setVisibility(message.text.trim().isEmpty() ? View.GONE : View.VISIBLE);
    bubble.addView(body, new LinearLayout.LayoutParams(-2, -2));
    for (int index = 0; index < message.attachments.length(); index++) {
      JSONObject descriptor = message.attachments.optJSONObject(index);
      if (descriptor != null) addAttachmentPreview(bubble, descriptor);
    }
    TextView meta = text(outgoing ? "你" : "Hermes", 11, outgoing ? R.color.on_brand : R.color.text_secondary);
    meta.setAlpha(0.78f);
    LinearLayout.LayoutParams metaParams = new LinearLayout.LayoutParams(-2, -2);
    metaParams.topMargin = dp(5);
    bubble.addView(meta, metaParams);
    int maximumWidth = (int) (getResources().getDisplayMetrics().widthPixels * 0.84f);
    row.addView(bubble, new LinearLayout.LayoutParams(Math.min(maximumWidth, dp(520)), -2));
    LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(-1, -2);
    rowParams.setMargins(0, dp(5), 0, dp(5));
    messages.addView(row, rowParams);
    if (message.sequence > 0) {
      renderedMessagesBySequence.put(message.sequence, new RenderedMessage(body, meta));
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
    rendered.meta.setText(message.finalUpdate ? "Hermes" : "Hermes · 正在回复");
    messageScroll.post(() -> messageScroll.fullScroll(View.FOCUS_DOWN));
  }

  private static final class RenderedMessage {
    final TextView body;
    final TextView meta;

    RenderedMessage(TextView body, TextView meta) {
      this.body = body;
      this.meta = meta;
    }
  }

  private void addAttachmentPreview(LinearLayout bubble, JSONObject descriptor) {
    if (selectedProfile == null || crypto == null) return;
    String spaceId = selectedProfile.id;
    HermesChatCrypto targetCrypto = crypto;
    long generation = profileGeneration;
    TextView loading = text("正在解密图片…", 12, R.color.text_secondary);
    LinearLayout.LayoutParams loadingParams = new LinearLayout.LayoutParams(dp(220), dp(42));
    loadingParams.topMargin = dp(6);
    bubble.addView(loading, loadingParams);
    executor.submit(() -> {
      try {
        byte[] ciphertext = api.downloadHermesChatAttachment(
          spaceId,
          descriptor.getString("id")
        );
        byte[] plaintext = targetCrypto.decryptAttachment(ciphertext, descriptor);
        Bitmap bitmap = BitmapFactory.decodeByteArray(plaintext, 0, plaintext.length);
        if (bitmap == null) throw new IllegalArgumentException("图片格式无法显示。");
        runOnUiThread(() -> {
          if (destroyed || generation != profileGeneration || selectedProfile == null
              || !spaceId.equals(selectedProfile.id)) return;
          int index = bubble.indexOfChild(loading);
          bubble.removeView(loading);
          ImageView image = new ImageView(this);
          image.setImageBitmap(bitmap);
          image.setScaleType(ImageView.ScaleType.CENTER_CROP);
          image.setContentDescription("加密聊天图片");
          image.setBackground(rounded(R.color.surface, 12));
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

  private void showSettings(View anchor) {
    if (selectedProfile == null) {
      toast("请先选择 Hermes 聊天对象。");
      return;
    }
    PopupMenu menu = new PopupMenu(this, anchor);
    menu.getMenu().add(0, 1, 0, "查看并复制聊天密钥").setIcon(R.drawable.ic_key);
    menu.getMenu().add(0, 2, 1, "替换聊天密钥").setIcon(R.drawable.ic_refresh);
    menu.setForceShowIcon(true);
    menu.setOnMenuItemClickListener(item -> {
      if (item.getItemId() == 1) {
        showKeyCopy(secureStore.loadHermesChatKey(selectedProfile.id));
      }
      else if (item.getItemId() == 2) showKeySetup(true);
      return true;
    });
    menu.show();
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

  private GradientDrawable rounded(int color, int radius) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setColor(getColor(color));
    drawable.setCornerRadius(dp(radius));
    return drawable;
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private void toast(String value) {
    Toast.makeText(this, value == null ? "操作失败。" : value, Toast.LENGTH_LONG).show();
  }
}
