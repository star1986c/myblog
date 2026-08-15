package io.qzz.superstar1014.mynotes;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.Intent;
import android.content.Context;
import android.content.DialogInterface;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.net.Uri;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.provider.MediaStore;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.GridView;
import android.widget.HorizontalScrollView;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

import javax.crypto.SecretKey;

public final class MainActivity extends Activity {
  private static final long AUTO_SAVE_DELAY_MS = 10_000L;
  private static final int REQUEST_IMAGE = 1201;
  private static final int REQUEST_CAMERA = 1202;
  private static final int REQUEST_RECORD_AUDIO_PERMISSION = 1203;
  private static final long MAX_RECORDING_DURATION_MS = 5 * 60 * 1000L;
  private static final String LOCATION_ALL = "all";
  private static final String LOCATION_UNFILED = "unfiled";
  private static final String LOCATION_TRASH = "trash";
  private static final String LOCATION_FOLDER_PREFIX = "folder:";

  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final List<Models.NoteDocument> notes = new ArrayList<>();
  private final List<Models.NoteDocument> trash = new ArrayList<>();
  private final List<Models.FolderDocument> folders = new ArrayList<>();
  private final List<Models.NoteDocument> visibleNotes = new ArrayList<>();
  private final List<Models.AttachmentDocument> attachments = new ArrayList<>();

  private NotesApiClient api;
  private AttachmentDiskCache attachmentCache;
  private BiometricProtectionStore biometricStore;
  private Models.User user;
  private SecretKey dataKey;
  private Models.ProtectionKeyring protectionKeyring;
  private SecretKey protectionKey;
  private Models.NoteDocument selectedNote;
  private String location = LOCATION_ALL;
  private String searchQuery = "";
  private int displayMode = 0;
  private boolean editorVisible;
  private boolean bindingEditor;
  private boolean dirty;
  private boolean saving;
  private boolean demoMode;
  private boolean attachmentsLoading;
  private String attachmentsNoteId;
  private long folderOrderGeneration;
  private String pendingCameraPath;
  private MediaRecorder recorder;
  private File recordingFile;
  private long recordingStartedAt;
  private AlertDialog recordingDialog;
  private TextView recordingTime;
  private Runnable recordingTicker;
  private MediaPlayer audioPlayer;
  private File playbackFile;
  private String playingAttachmentId;
  private String pendingPlaybackAttachmentId;

  private EditText titleField;
  private EditText bodyField;
  private TextView saveStatus;
  private FrameLayout homeListContainer;
  private TextView homeCount;
  private HorizontalScrollView attachmentScroller;
  private LinearLayout attachmentGallery;
  private Runnable pendingAutoSave;
  private OnBackInvokedCallback backCallback;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().setNavigationBarContrastEnforced(false);
    demoMode = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0
      && getIntent().getBooleanExtra("demo", false);
    backCallback = this::handleBackNavigation;
    getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
      OnBackInvokedDispatcher.PRIORITY_DEFAULT,
      backCallback
    );
    api = new NotesApiClient(this, demoMode ? "http://127.0.0.1:9/" : NotesApiClient.PRODUCTION_BASE_URL);
    attachmentCache = new AttachmentDiskCache(this);
    biometricStore = new BiometricProtectionStore(this);
    if (savedInstanceState != null) pendingCameraPath = savedInstanceState.getString("cameraPath");
    if (demoMode) loadDemoData();
    else restoreSession();
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode == REQUEST_IMAGE) {
      if (resultCode != RESULT_OK || data == null) return;
      Uri uri = data.getData();
      if (uri != null) importImage(uri, null);
      return;
    }
    if (requestCode == REQUEST_CAMERA) {
      File captured = pendingCameraPath == null ? null : new File(pendingCameraPath);
      pendingCameraPath = null;
      if (resultCode != RESULT_OK || captured == null || !captured.isFile()) {
        deleteTemporaryFile(captured);
        return;
      }
      try {
        Uri uri = CameraFileProvider.uriFor(this, captured);
        createNote(captureTitle("拍照记事"), false, note -> importImage(uri, () -> deleteTemporaryFile(captured)));
      } catch (Exception error) {
        deleteTemporaryFile(captured);
        showError(error);
      }
    }
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode != REQUEST_RECORD_AUDIO_PERMISSION) return;
    if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
      beginRecording();
    } else {
      toast("需要麦克风权限才能直接录音。可在系统设置中重新允许。");
    }
  }

  @Override
  protected void onSaveInstanceState(Bundle state) {
    super.onSaveInstanceState(state);
    if (pendingCameraPath != null) state.putString("cameraPath", pendingCameraPath);
  }

  private void loadDemoData() {
    try {
      user = new Models.User("demo", false);
      dataKey = CryptoEngine.importDataKey(
        "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
      );
      folders.clear();
      folders.add(new Models.FolderDocument(
        demoFolderEnvelope("folder_demo_linux"),
        "Linux"
      ));
      folders.add(new Models.FolderDocument(
        demoFolderEnvelope("folder_demo_account"),
        "账号信息"
      ));
      notes.clear();
      notes.add(demoNote(
        "note_demo_android",
        "folder_demo_linux",
        "Android 开发记录",
        "API、AES-GCM 加密兼容和移动端列表布局已经完成。",
        false
      ));
      notes.add(demoNote(
        "note_demo_search",
        null,
        "搜索与文件夹",
        "可以搜索标题和正文，并按文件夹筛选笔记。",
        false
      ));
      CryptoEngine.ProtectionSetup demoProtection = CryptoEngine.createProtectionKeyring(
        "demo-protection-2026"
      );
      protectionKeyring = Models.ProtectionKeyring.fromJson(
        new JSONObject(demoProtection.payload.toString()).put("revision", 1)
      );
      Models.NoteDocument protectedDemo = demoNote(
        "note_demo_protected",
        "folder_demo_account",
        "账号安全约定",
        "",
        true
      );
      protectedDemo.content.protectedContent = CryptoEngine.encryptProtectedBody(
        demoProtection.key,
        protectedDemo.envelope.id,
        "这是仅用于 Android 界面验证的受保护示例正文。"
      );
      notes.add(protectedDemo);
      trash.clear();
      Models.NoteDocument deleted = demoNote(
        "note_demo_deleted",
        null,
        "已删除的示例笔记",
        "可以从回收站恢复。",
        false
      );
      deleted.envelope.deletedAt = "2026-08-14T06:00:00Z";
      trash.add(deleted);
      renderHome();
    } catch (Exception error) {
      showError(error);
    }
  }

  private Models.FolderEnvelope demoFolderEnvelope(String id) {
    return new Models.FolderEnvelope(
      id,
      1,
      1,
      "demo_ciphertext",
      "demo_nonce",
      0,
      "2026-08-14T06:00:00Z",
      "2026-08-14T06:00:00Z"
    );
  }

  private Models.NoteDocument demoNote(
    String id,
    String folderId,
    String title,
    String body,
    boolean locked
  ) {
    Models.ProtectedBody protectedBody = locked
      ? new Models.ProtectedBody(1, "demo_ciphertext", "demo_nonce")
      : null;
    Models.NoteEnvelope envelope = new Models.NoteEnvelope(
      id,
      folderId,
      1,
      1,
      "demo_ciphertext",
      "demo_nonce",
      "2026-08-14T06:00:00Z",
      "2026-08-14T06:00:00Z",
      null,
      locked
    );
    return new Models.NoteDocument(
      envelope,
      new Models.NoteContent(title, body, protectedBody)
    );
  }

  @Override
  protected void onDestroy() {
    if (backCallback != null) {
      getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
    }
    discardActiveRecording();
    stopAudioPlayback();
    handler.removeCallbacksAndMessages(null);
    executor.shutdownNow();
    super.onDestroy();
  }

  private void handleBackNavigation() {
    if (editorVisible) {
      closeEditor();
    } else {
      finish();
    }
  }

  @Override
  public boolean onKeyShortcut(int keyCode, KeyEvent event) {
    if (keyCode == KeyEvent.KEYCODE_S && event.isCtrlPressed() && editorVisible) {
      saveSelected(null);
      return true;
    }
    return super.onKeyShortcut(keyCode, event);
  }

  private void restoreSession() {
    showLoading("正在恢复登录状态…");
    runAsync(api::restoreSession, session -> {
      if (!session.authenticated) {
        showLogin();
        return;
      }
      user = session.user;
      loadAllData();
    });
  }

  private void loadAllData() {
    showLoading("正在解密笔记…");
    runAsync(() -> {
      SecretKey key = CryptoEngine.importDataKey(api.workspaceKey());
      Models.ProtectionKeyring keyring = api.protectionKeyring();
      List<Models.FolderDocument> loadedFolders = new ArrayList<>();
      for (Models.FolderEnvelope envelope : api.listFolders()) {
        loadedFolders.add(new Models.FolderDocument(envelope, CryptoEngine.decryptFolder(key, envelope)));
      }
      List<Models.NoteDocument> loadedNotes = decryptNotes(key, api.listNotes(false));
      List<Models.NoteDocument> loadedTrash = decryptNotes(key, api.listNotes(true));
      return new LoadedData(key, keyring, loadedFolders, loadedNotes, loadedTrash);
    }, loaded -> {
      dataKey = loaded.dataKey;
      protectionKeyring = loaded.keyring;
      folders.clear();
      folders.addAll(loaded.folders);
      notes.clear();
      notes.addAll(loaded.notes);
      trash.clear();
      trash.addAll(loaded.trash);
      renderHome();
    });
  }

  private List<Models.NoteDocument> decryptNotes(
    SecretKey key,
    List<Models.NoteEnvelope> envelopes
  ) throws Exception {
    List<Models.NoteDocument> result = new ArrayList<>();
    for (Models.NoteEnvelope envelope : envelopes) {
      result.add(new Models.NoteDocument(envelope, CryptoEngine.decryptNote(key, envelope)));
    }
    result.sort(Comparator.comparing(
      document -> document.envelope.updatedAt == null ? "" : document.envelope.updatedAt,
      Comparator.reverseOrder()
    ));
    return result;
  }

  private void showLogin() {
    editorVisible = false;
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(getColor(R.color.background));
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.setClipToPadding(false);

    LinearLayout form = verticalLayout(0);
    form.setPadding(dp(24), dp(36), dp(24), dp(36));

    LinearLayout brand = horizontalLayout(Gravity.CENTER_VERTICAL);
    ImageView logo = iconView(R.drawable.ic_note, R.color.on_brand, "My Notes", 28);
    logo.setBackground(roundedBackground(R.color.brand_primary, 16));
    logo.setPadding(dp(12), dp(12), dp(12), dp(12));
    brand.addView(logo, new LinearLayout.LayoutParams(dp(52), dp(52)));
    TextView wordmark = text("My Notes", 18, R.color.text_primary);
    wordmark.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    brand.addView(wordmark, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      dp(52)
    ));
    ((LinearLayout.LayoutParams) wordmark.getLayoutParams()).setMarginStart(dp(12));
    form.addView(brand, matchWrap(0, 0, 0, 48));

    TextView eyebrow = text("你的私人笔记空间", 13, R.color.brand_primary_dark);
    eyebrow.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    form.addView(eyebrow, matchWrap(2, 0, 0, 8));

    TextView title = text("欢迎回来", 34, R.color.text_primary);
    title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    form.addView(title, matchWrap(0, 0, 0, 8));

    TextView subtitle = text(getString(R.string.login_description), 15, R.color.text_secondary);
    subtitle.setLineSpacing(0, 1.25f);
    form.addView(subtitle, matchWrap(0, 0, 0, 28));

    LinearLayout card = verticalLayout(0);
    card.setPadding(dp(20), dp(22), dp(20), dp(20));
    card.setBackground(roundedStrokeBackground(R.color.surface, R.color.divider, 24, 1));

    TextView usernameLabel = text(getString(R.string.username), 14, R.color.text_primary);
    usernameLabel.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    card.addView(usernameLabel, matchWrap(2, 0, 0, 8));
    EditText usernameField = editText(getString(R.string.username), false);
    usernameField.setSingleLine(true);
    usernameField.setInputType(InputType.TYPE_CLASS_TEXT);
    card.addView(usernameField, matchHeight(dp(56), 0, 0, 0, 20));

    TextView passwordLabel = text(getString(R.string.password), 14, R.color.text_primary);
    passwordLabel.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    card.addView(passwordLabel, matchWrap(2, 0, 0, 8));
    EditText passwordField = editText(getString(R.string.password), true);
    passwordField.setSingleLine(true);
    card.addView(passwordField, matchHeight(dp(56), 0, 0, 0, 6));

    CheckBox showPassword = new CheckBox(this);
    showPassword.setText(R.string.show_password);
    showPassword.setTextColor(getColor(R.color.text_secondary));
    showPassword.setMinHeight(dp(48));
    showPassword.setOnCheckedChangeListener((button, checked) -> {
      passwordField.setInputType(
        InputType.TYPE_CLASS_TEXT
          | (checked ? InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD : InputType.TYPE_TEXT_VARIATION_PASSWORD)
      );
      passwordField.setSelection(passwordField.length());
    });
    showPassword.setButtonTintList(ColorStateList.valueOf(getColor(R.color.brand_primary)));
    card.addView(showPassword, matchHeight(dp(48), 0, 0, 0, 16));

    IconTextButton loginButton = primaryIconButton(getString(R.string.login), R.drawable.ic_login);
    loginButton.setOnClickListener(view -> {
      String username = usernameField.getText().toString().trim();
      String password = passwordField.getText().toString();
      if (username.isEmpty() || password.isEmpty()) {
        toast("请输入账号和密码。");
        return;
      }
      loginButton.setEnabled(false);
      loginButton.setText("正在登录…");
      runAsync(() -> api.login(username, password), loggedInUser -> {
        user = loggedInUser;
        loadAllData();
      }, error -> {
        loginButton.setEnabled(true);
        loginButton.setText(getString(R.string.login));
        showError(error);
      });
    });
    passwordField.setOnEditorActionListener((view, actionId, event) -> {
      loginButton.performClick();
      return true;
    });
    card.addView(loginButton, matchHeight(dp(56), 0, 0, 0, 0));
    form.addView(card, matchWrap(0, 0, 0, 20));

    LinearLayout security = horizontalLayout(Gravity.CENTER_VERTICAL);
    ImageView lock = iconView(R.drawable.ic_lock, R.color.text_secondary, "端到端加密", 18);
    security.addView(lock, new LinearLayout.LayoutParams(dp(32), dp(32)));
    TextView securityText = text("笔记内容加密后同步，服务器不保存明文", 13, R.color.text_secondary);
    securityText.setLineSpacing(0, 1.2f);
    security.addView(securityText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
    form.addView(security, matchWrap(4, 0, 4, 0));

    scroll.addView(form, new ScrollView.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));
    root.addView(scroll, frameMatch());
    setContentView(applySystemInsets(root));
  }

  private void renderHome() {
    editorVisible = false;
    selectedNote = null;
    clearAttachments();
    protectionKey = null;
    handler.removeCallbacksAndMessages(null);
    dirty = false;
    saving = false;
    filterVisibleNotes();
    boolean landscape = getResources().getConfiguration().orientation
      == android.content.res.Configuration.ORIENTATION_LANDSCAPE;
    boolean largeText = getResources().getConfiguration().fontScale >= 1.2f;
    int summaryHeight = landscape ? (largeText ? 64 : 54) : (largeText ? 72 : 62);

    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(getColor(R.color.background));
    LinearLayout column = verticalLayout(0);
    root.addView(column, frameMatch());

    LinearLayout topBar = horizontalLayout(Gravity.CENTER_VERTICAL);
    topBar.setPadding(dp(18), landscape ? dp(6) : dp(10), dp(14), landscape ? dp(4) : dp(6));
    ImageView brandIcon = iconView(R.drawable.ic_note, R.color.on_brand, "My Notes", 22);
    brandIcon.setBackground(roundedBackground(R.color.brand_primary, 14));
    brandIcon.setPadding(dp(10), dp(10), dp(10), dp(10));
    topBar.addView(brandIcon, new LinearLayout.LayoutParams(dp(44), dp(44)));

    LinearLayout heading = verticalLayout(0);
    TextView appTitle = text("My Notes", 21, R.color.text_primary);
    appTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    heading.addView(appTitle, matchWrap(0, 0, 0, 0));
    TextView account = text(user == null ? "" : user.username, 12, R.color.text_secondary);
    heading.addView(account, matchWrap(0, 0, 0, 0));
    LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(0, dp(52), 1);
    headingParams.setMarginStart(dp(12));
    topBar.addView(heading, headingParams);

    ImageButton refresh = iconButton(R.drawable.ic_refresh, "刷新笔记", false);
    refresh.setOnClickListener(view -> loadAllData());
    topBar.addView(refresh, new LinearLayout.LayoutParams(dp(48), dp(48)));
    ImageButton profile = iconButton(R.drawable.ic_person, "账户与安全", true);
    profile.setOnClickListener(this::showAccountMenu);
    LinearLayout.LayoutParams profileParams = new LinearLayout.LayoutParams(dp(48), dp(48));
    profileParams.setMarginStart(dp(6));
    topBar.addView(profile, profileParams);
    column.addView(topBar, matchHeight(dp(landscape ? 60 : 68), 0, 0, 0, 0));

    EditText search = editText(getString(R.string.search_notes), false);
    search.setSingleLine(true);
    search.setText(searchQuery);
    Drawable searchIcon = getDrawable(R.drawable.ic_search);
    searchIcon.setTint(getColor(R.color.text_secondary));
    search.setCompoundDrawablesWithIntrinsicBounds(searchIcon, null, null, null);
    search.setCompoundDrawablePadding(dp(10));
    search.setBackground(roundedStrokeBackground(R.color.surface, R.color.divider, 24, 1));
    search.setPadding(dp(16), dp(8), dp(16), dp(8));
    search.addTextChangedListener(new SimpleTextWatcher() {
      @Override public void afterTextChanged(Editable editable) {
        searchQuery = editable.toString();
        renderHomeListOnly();
      }
    });
    LinearLayout.LayoutParams searchParams = matchHeight(
      dp(landscape ? 48 : 56),
      18,
      landscape ? 0 : 2,
      18,
      landscape ? 6 : 10
    );
    column.addView(search, searchParams);

    if (!landscape && !largeText) {
      LinearLayout shortcuts = horizontalLayout(Gravity.CENTER_VERTICAL);
      shortcuts.setPadding(dp(14), 0, dp(14), 0);
      Button quickNote = shortcutButton("新建笔记", R.drawable.ic_edit);
      quickNote.setOnClickListener(view -> createNote());
      shortcuts.addView(quickNote, shortcutParams());
      Button quickVoice = shortcutButton("语音记事", R.drawable.ic_mic);
      quickVoice.setOnClickListener(view -> startVoiceNote());
      shortcuts.addView(quickVoice, shortcutParams());
      Button quickPhoto = shortcutButton("拍照记事", R.drawable.ic_camera);
      quickPhoto.setOnClickListener(view -> startPhotoNote());
      shortcuts.addView(quickPhoto, shortcutParams());
      Button quickFolder = shortcutButton("文件夹", R.drawable.ic_folder);
      quickFolder.setOnClickListener(this::showLocationMenu);
      shortcuts.addView(quickFolder, shortcutParams());
      column.addView(shortcuts, matchHeight(dp(96), 0, 0, 0, 10));
    }

    LinearLayout contentSheet = verticalLayout(0);
    contentSheet.setBackground(roundedBackground(R.color.surface, 28));

    LinearLayout summary = horizontalLayout(Gravity.CENTER_VERTICAL);
    summary.setPadding(dp(20), 0, dp(14), 0);
    LinearLayout summaryText = verticalLayout(0);
    TextView locationTitle = text(locationTitle(), 21, R.color.text_primary);
    locationTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    summaryText.addView(locationTitle, matchWrap(0, 0, 0, 0));
    int count = visibleNotes.size();
    homeCount = text(
      getResources().getQuantityString(R.plurals.note_count, count, count),
      13,
      R.color.text_secondary
    );
    summaryText.addView(homeCount, matchWrap(0, 0, 0, 0));
    summary.addView(summaryText, new LinearLayout.LayoutParams(0, dp(summaryHeight), 1));
    ImageButton mode = iconButton(modeIcon(), "切换笔记列表显示方式，当前" + modeTitle(), false);
    mode.setOnClickListener(this::showModeMenu);
    summary.addView(mode, new LinearLayout.LayoutParams(dp(48), dp(48)));
    contentSheet.addView(summary, matchHeight(dp(summaryHeight), 0, 0, 0, 0));

    HorizontalScrollView folderScroll = new HorizontalScrollView(this);
    folderScroll.setHorizontalScrollBarEnabled(false);
    folderScroll.setClipToPadding(false);
    folderScroll.setPadding(dp(14), 0, dp(14), 0);
    LinearLayout folderRail = horizontalLayout(Gravity.CENTER_VERTICAL);
    addFolderChip(folderRail, "全部", LOCATION_ALL, R.drawable.ic_home);
    for (Models.FolderDocument folder : folders) {
      addFolderChip(
        folderRail,
        folder.name,
        LOCATION_FOLDER_PREFIX + folder.envelope.id,
        R.drawable.ic_folder
      );
    }
    folderScroll.addView(folderRail, new HorizontalScrollView.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      dp(landscape ? 42 : 48)
    ));
    contentSheet.addView(folderScroll, matchHeight(dp(landscape ? 42 : 48), 0, 0, 0, 4));

    homeListContainer = new FrameLayout(this);
    homeListContainer.setId(View.generateViewId());
    contentSheet.addView(homeListContainer, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      0,
      1
    ));
    populateListContainer(homeListContainer);

    LinearLayout.LayoutParams sheetParams = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      0,
      1
    );
    sheetParams.setMargins(dp(10), 0, dp(10), dp(6));
    column.addView(contentSheet, sheetParams);

    column.addView(buildBottomNavigation(), matchHeight(dp(landscape ? 68 : 78), 0, 0, 0, 0));
    setContentView(applySystemInsets(root));
  }

  private LinearLayout buildBottomNavigation() {
    LinearLayout navigation = horizontalLayout(Gravity.CENTER);
    navigation.setPadding(dp(6), dp(4), dp(6), dp(4));
    navigation.setBackground(roundedBackground(R.color.surface, 24));

    Button recent = navigationButton("最新", R.drawable.ic_home, LOCATION_ALL.equals(location));
    recent.setOnClickListener(view -> {
      location = LOCATION_ALL;
      searchQuery = "";
      renderHome();
    });
    navigation.addView(recent, weightedNavigationParams());

    Button folder = navigationButton(
      "文件夹",
      R.drawable.ic_folder,
      location.startsWith(LOCATION_FOLDER_PREFIX)
    );
    folder.setOnClickListener(this::showLocationMenu);
    navigation.addView(folder, weightedNavigationParams());

    ImageButton add = iconButton(R.drawable.ic_add, getString(R.string.new_note), false);
    add.setImageTintList(ColorStateList.valueOf(getColor(R.color.on_brand)));
    add.setBackground(rippleBackground(R.color.brand_primary, 28));
    add.setOnClickListener(this::showCreateMenu);
    LinearLayout.LayoutParams addParams = new LinearLayout.LayoutParams(dp(58), dp(58));
    addParams.setMargins(dp(8), dp(4), dp(8), dp(4));
    navigation.addView(add, addParams);

    Button trashButton = navigationButton("回收站", R.drawable.ic_trash, LOCATION_TRASH.equals(location));
    trashButton.setOnClickListener(view -> {
      location = LOCATION_TRASH;
      searchQuery = "";
      renderHome();
    });
    navigation.addView(trashButton, weightedNavigationParams());

    Button accountButton = navigationButton("我的", R.drawable.ic_person, false);
    accountButton.setOnClickListener(this::showAccountMenu);
    navigation.addView(accountButton, weightedNavigationParams());
    return navigation;
  }

  private void showCreateMenu(View anchor) {
    PopupMenu menu = new PopupMenu(this, anchor);
    menu.getMenu().add(0, 1, 0, "新建笔记").setIcon(R.drawable.ic_edit);
    menu.getMenu().add(0, 2, 1, "语音记事").setIcon(R.drawable.ic_mic);
    menu.getMenu().add(0, 3, 2, "拍照记事").setIcon(R.drawable.ic_camera);
    menu.setForceShowIcon(true);
    menu.setOnMenuItemClickListener(item -> {
      if (item.getItemId() == 1) createNote();
      else if (item.getItemId() == 2) startVoiceNote();
      else if (item.getItemId() == 3) startPhotoNote();
      return true;
    });
    menu.show();
  }

  private Button shortcutButton(String label, int iconRes) {
    Button button = new Button(this);
    button.setText(label);
    button.setTextSize(12);
    button.setTextColor(getColor(R.color.text_primary));
    button.setAllCaps(false);
    button.setGravity(Gravity.CENTER);
    button.setPadding(dp(5), dp(8), dp(5), dp(8));
    button.setMinHeight(dp(84));
    Drawable icon = getDrawable(iconRes);
    icon.setTint(getColor(R.color.brand_primary_dark));
    icon.setBounds(0, 0, dp(26), dp(26));
    button.setCompoundDrawablePadding(dp(8));
    button.setCompoundDrawables(null, icon, null, null);
    button.setBackground(rippleStrokeBackground(R.color.surface, R.color.divider, 20));
    return button;
  }

  private Button navigationButton(String label, int iconRes, boolean selected) {
    Button button = new Button(this);
    button.setText(label);
    button.setTextSize(11);
    button.setTypeface(Typeface.DEFAULT, selected ? Typeface.BOLD : Typeface.NORMAL);
    button.setTextColor(getColor(selected ? R.color.brand_primary_dark : R.color.text_secondary));
    button.setAllCaps(false);
    button.setGravity(Gravity.CENTER);
    button.setPadding(dp(4), dp(5), dp(4), dp(3));
    button.setMinHeight(dp(56));
    Drawable icon = getDrawable(iconRes);
    icon.setTint(getColor(selected ? R.color.brand_primary_dark : R.color.text_secondary));
    icon.setBounds(0, 0, dp(23), dp(23));
    button.setCompoundDrawablePadding(dp(3));
    button.setCompoundDrawables(null, icon, null, null);
    button.setBackground(rippleBackground(selected ? R.color.surface_tonal : R.color.surface, 16));
    button.setSelected(selected);
    button.setContentDescription(label + (selected ? "，已选择" : ""));
    return button;
  }

  private LinearLayout.LayoutParams shortcutParams() {
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(88), 1);
    params.setMargins(dp(4), 0, dp(4), 0);
    return params;
  }

  private LinearLayout.LayoutParams weightedNavigationParams() {
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(64), 1);
    params.setMargins(dp(2), 0, dp(2), 0);
    return params;
  }

  private void addFolderChip(LinearLayout rail, String label, String value, int iconRes) {
    Button chip = chipButton(label, iconRes, value.equals(location));
    chip.setOnClickListener(view -> {
      location = value;
      searchQuery = "";
      renderHome();
    });
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      dp(40)
    );
    params.setMargins(dp(4), dp(4), dp(4), dp(4));
    rail.addView(chip, params);
  }

  private void renderHomeListOnly() {
    if (homeListContainer == null) return;
    filterVisibleNotes();
    homeListContainer.removeAllViews();
    populateListContainer(homeListContainer);
    if (homeCount != null) {
      int count = visibleNotes.size();
      homeCount.setText(getResources().getQuantityString(R.plurals.note_count, count, count));
    }
  }

  private void filterVisibleNotes() {
    visibleNotes.clear();
    List<Models.NoteDocument> source = LOCATION_TRASH.equals(location) ? trash : notes;
    boolean globalSearch = !LOCATION_TRASH.equals(location) && !searchQuery.trim().isEmpty();
    for (Models.NoteDocument note : source) {
      boolean matchesLocation;
      if (globalSearch || LOCATION_ALL.equals(location) || LOCATION_TRASH.equals(location)) {
        matchesLocation = true;
      } else if (LOCATION_UNFILED.equals(location)) {
        matchesLocation = note.envelope.folderId == null;
      } else {
        matchesLocation = location.equals(LOCATION_FOLDER_PREFIX + note.envelope.folderId);
      }
      if (matchesLocation && note.matches(searchQuery)) visibleNotes.add(note);
    }
  }

  private void populateListContainer(FrameLayout container) {
    if (visibleNotes.isEmpty()) {
      LinearLayout empty = verticalLayout(0);
      empty.setGravity(Gravity.CENTER);
      int emptyIcon = LOCATION_TRASH.equals(location) ? R.drawable.ic_trash : R.drawable.ic_note;
      ImageView icon = iconView(emptyIcon, R.color.brand_primary_dark, "空状态", 30);
      icon.setPadding(dp(18), dp(18), dp(18), dp(18));
      icon.setBackground(roundedBackground(R.color.surface_tonal, 28));
      empty.addView(icon, new LinearLayout.LayoutParams(dp(72), dp(72)));
      boolean searchEmpty = !searchQuery.trim().isEmpty();
      TextView label = text(
        searchEmpty ? "没有找到相关笔记" : LOCATION_TRASH.equals(location) ? "回收站是空的" : "从第一条笔记开始",
        18,
        R.color.text_primary
      );
      label.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
      label.setGravity(Gravity.CENTER);
      empty.addView(label, matchWrap(24, 18, 24, 6));
      TextView detail = text(
        searchEmpty ? "换一个关键词，或清空搜索后再试" : LOCATION_TRASH.equals(location)
          ? "删除的笔记会在这里保留，方便恢复"
          : "记录灵感、资料和重要信息",
        14,
        R.color.text_secondary
      );
      detail.setGravity(Gravity.CENTER);
      empty.addView(detail, matchWrap(32, 0, 32, 0));
      container.addView(empty, frameMatch());
      return;
    }

    NotesAdapter adapter = new NotesAdapter();
    AdapterView<?> list;
    if (displayMode == 1) {
      GridView grid = new GridView(this);
      grid.setNumColumns(getResources().getConfiguration().smallestScreenWidthDp >= 600 ? 3 : 2);
      grid.setHorizontalSpacing(dp(4));
      grid.setVerticalSpacing(dp(4));
      grid.setPadding(dp(12), dp(4), dp(12), dp(12));
      grid.setClipToPadding(false);
      grid.setAdapter(adapter);
      list = grid;
    } else {
      ListView rows = new ListView(this);
      rows.setDivider(null);
      rows.setDividerHeight(0);
      rows.setPadding(dp(12), 0, dp(12), dp(8));
      rows.setClipToPadding(false);
      rows.setAdapter(adapter);
      list = rows;
    }
    list.setOnItemClickListener((parent, view, position, id) -> {
      selectedNote = visibleNotes.get(position);
      renderEditor();
    });
    container.addView((View) list, frameMatch());
  }

  private void showLocationMenu(View anchor) {
    PopupMenu menu = new PopupMenu(this, anchor);
    menu.getMenu().add(0, 1, 0, "全部笔记（" + notes.size() + "）").setIcon(R.drawable.ic_note);
    int nextId = 100;
    for (Models.FolderDocument folder : folders) {
      int count = 0;
      for (Models.NoteDocument note : notes) {
        if (folder.envelope.id.equals(note.envelope.folderId)) count++;
      }
      menu.getMenu().add(1, nextId++, nextId, folder.name + "（" + count + "）").setIcon(R.drawable.ic_folder);
    }
    menu.getMenu().add(2, 3, 1_000, "新建文件夹").setIcon(R.drawable.ic_add);
    if (!folders.isEmpty()) menu.getMenu().add(2, 6, 1_001, "文件夹排序与管理").setIcon(R.drawable.ic_sort);
    menu.setOnMenuItemClickListener(item -> {
      if (item.getItemId() == 1) location = LOCATION_ALL;
      else if (item.getItemId() == 3) {
        createFolder();
        return true;
      } else if (item.getItemId() == 6) {
        manageFolders();
        return true;
      }
      else if (item.getGroupId() == 1) {
        int index = item.getItemId() - 100;
        if (index >= 0 && index < folders.size()) {
          location = LOCATION_FOLDER_PREFIX + folders.get(index).envelope.id;
        }
      }
      searchQuery = "";
      renderHome();
      return true;
    });
    menu.show();
  }

  private void showAccountMenu(View anchor) {
    PopupMenu menu = new PopupMenu(this, anchor);
    boolean fingerprintConfigured = biometricStore.isConfiguredFor(protectionKeyring);
    android.view.MenuItem fingerprint = menu.getMenu().add(
      0,
      8,
      0,
      fingerprintConfigured ? "关闭指纹解锁" : "启用指纹解锁"
    ).setIcon(R.drawable.ic_fingerprint);
    if (!fingerprintConfigured && !biometricStore.isAvailable()) {
      fingerprint.setTitle("指纹解锁不可用");
    }
    menu.getMenu().add(0, 7, 1, "修改登录密码").setIcon(R.drawable.ic_key);
    menu.getMenu().add(0, 5, 2, "退出登录").setIcon(R.drawable.ic_logout);
    menu.setOnMenuItemClickListener(item -> {
      if (item.getItemId() == 8) {
        if (fingerprintConfigured) disableBiometric();
        else enableBiometricFromSettings();
        return true;
      }
      if (item.getItemId() == 7) {
        showChangePasswordDialog();
        return true;
      }
      if (item.getItemId() == 5) {
        logout();
        return true;
      }
      return false;
    });
    menu.show();
  }

  private void showModeMenu(View anchor) {
    PopupMenu menu = new PopupMenu(this, anchor);
    menu.getMenu().add(0, 10, 0, "详细列表").setIcon(R.drawable.ic_list).setCheckable(true).setChecked(displayMode == 0);
    menu.getMenu().add(0, 11, 1, "图文卡片").setIcon(R.drawable.ic_grid).setCheckable(true).setChecked(displayMode == 1);
    menu.getMenu().add(0, 12, 2, "标题列表").setIcon(R.drawable.ic_title).setCheckable(true).setChecked(displayMode == 2);
    menu.setOnMenuItemClickListener(item -> {
      displayMode = item.getItemId() - 10;
      renderHome();
      return true;
    });
    menu.show();
  }

  private void createNote() {
    createNote("无标题笔记", true, null);
  }

  private void createNote(
    String initialTitle,
    boolean focusTitle,
    Consumer<Models.NoteDocument> completion
  ) {
    String id = UUID.randomUUID().toString();
    String targetFolder = location.startsWith(LOCATION_FOLDER_PREFIX)
      ? location.substring(LOCATION_FOLDER_PREFIX.length())
      : folders.isEmpty() ? null : folders.get(0).envelope.id;
    if (demoMode) {
      Models.NoteDocument document = demoNote(id, targetFolder, initialTitle, "", false);
      notes.add(0, document);
      selectedNote = document;
      renderEditor();
      if (focusTitle) titleField.selectAll();
      if (completion != null) completion.accept(document);
      return;
    }
    showLoading("正在创建笔记…");
    runAsync(() -> {
      Models.NoteContent content = new Models.NoteContent(initialTitle, "", null);
      Models.NoteEnvelope envelope = api.createNote(CryptoEngine.encryptNote(dataKey, id, content));
      if (targetFolder != null) {
        JSONObject moved = api.moveNote(envelope.id, targetFolder, envelope.revision);
        applyMutation(envelope, moved);
      }
      return new Models.NoteDocument(envelope, content);
    }, document -> {
      notes.add(0, document);
      selectedNote = document;
      renderEditor();
      if (focusTitle) {
        titleField.selectAll();
        titleField.requestFocus();
        keyboard(titleField, true);
      }
      if (completion != null) completion.accept(document);
    });
  }

  private void renderEditor() {
    if (selectedNote == null) {
      renderHome();
      return;
    }
    editorVisible = true;
    bindingEditor = true;
    handler.removeCallbacksAndMessages(null);

    LinearLayout root = verticalLayout(0);
    root.setBackgroundColor(getColor(R.color.background));

    LinearLayout topBar = horizontalLayout(Gravity.CENTER_VERTICAL);
    topBar.setPadding(dp(10), dp(8), dp(10), dp(8));
    ImageButton back = iconButton(R.drawable.ic_arrow_back, "返回笔记列表", false);
    back.setOnClickListener(view -> closeEditor());
    topBar.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));

    LinearLayout context = verticalLayout(0);
    TextView folder = text(folderName(selectedNote.envelope.folderId), 14, R.color.text_primary);
    folder.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    context.addView(folder, matchWrap(0, 0, 0, 0));
    saveStatus = text(saveStatusText(), 12, dirty ? R.color.warning : R.color.text_secondary);
    context.addView(saveStatus, matchWrap(0, 0, 0, 0));
    LinearLayout.LayoutParams contextParams = new LinearLayout.LayoutParams(0, dp(52), 1);
    contextParams.setMarginStart(dp(8));
    topBar.addView(context, contextParams);

    if (!LOCATION_TRASH.equals(location)) {
      if (!selectedNote.envelope.locked || selectedNote.unlocked) {
        ImageButton image = iconButton(R.drawable.ic_image_add, "添加图片", false);
        image.setOnClickListener(view -> chooseImage());
        topBar.addView(image, new LinearLayout.LayoutParams(dp(48), dp(48)));
      }
      ImageButton save = iconButton(R.drawable.ic_save, "保存笔记", true);
      save.setOnClickListener(view -> saveSelected(null));
      topBar.addView(save, new LinearLayout.LayoutParams(dp(48), dp(48)));
    }
    ImageButton more = iconButton(R.drawable.ic_more, "更多笔记操作", false);
    more.setOnClickListener(this::showEditorActions);
    LinearLayout.LayoutParams moreParams = new LinearLayout.LayoutParams(dp(48), dp(48));
    moreParams.setMarginStart(dp(8));
    topBar.addView(more, moreParams);
    root.addView(topBar, matchHeight(dp(68), 0, 0, 0, 0));

    LinearLayout paper = verticalLayout(0);
    paper.setBackground(roundedStrokeBackground(R.color.surface, R.color.divider, 24, 1));

    LinearLayout noteMeta = horizontalLayout(Gravity.CENTER_VERTICAL);
    noteMeta.setPadding(dp(20), dp(12), dp(20), 0);
    ImageView noteIcon = iconView(
      selectedNote.envelope.locked ? R.drawable.ic_lock : R.drawable.ic_note,
      R.color.brand_primary_dark,
      selectedNote.envelope.locked ? "受保护笔记" : "普通笔记",
      16
    );
    noteMeta.addView(noteIcon, new LinearLayout.LayoutParams(dp(28), dp(28)));
    TextView date = text(selectedNote.envelope.displayDate(), 12, R.color.text_secondary);
    noteMeta.addView(date, new LinearLayout.LayoutParams(0, dp(32), 1));
    paper.addView(noteMeta, matchHeight(dp(44), 0, 0, 0, 0));

    titleField = editText("无标题笔记", false);
    titleField.setText(selectedNote.content.title);
    titleField.setTextSize(27);
    titleField.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    titleField.setSingleLine(false);
    titleField.setMaxLines(3);
    titleField.setPadding(dp(20), dp(4), dp(20), dp(10));
    titleField.setBackgroundColor(Color.TRANSPARENT);
    titleField.setEnabled(!LOCATION_TRASH.equals(location));
    titleField.addTextChangedListener(editorWatcher(true));
    paper.addView(titleField, matchWrap(0, 0, 0, 0));

    View divider = new View(this);
    divider.setBackgroundColor(getColor(R.color.divider));
    paper.addView(divider, matchHeight(dp(1), 20, 0, 20, 0));

    attachmentGallery = horizontalLayout(Gravity.CENTER_VERTICAL);
    attachmentGallery.setPadding(dp(8), dp(8), dp(8), dp(8));
    attachmentScroller = new HorizontalScrollView(this);
    attachmentScroller.setHorizontalScrollBarEnabled(false);
    attachmentScroller.setFillViewport(false);
    attachmentScroller.addView(attachmentGallery, new HorizontalScrollView.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    paper.addView(attachmentScroller, matchHeight(dp(132), 12, 4, 12, 2));
    renderAttachmentGallery();

    if (selectedNote.envelope.locked && !selectedNote.unlocked) {
      LinearLayout lockPanel = verticalLayout(0);
      lockPanel.setGravity(Gravity.CENTER);
      lockPanel.setPadding(dp(28), dp(36), dp(28), dp(36));
      ImageView lock = iconView(R.drawable.ic_lock, R.color.brand_primary_dark, "正文已锁定", 32);
      lock.setPadding(dp(20), dp(20), dp(20), dp(20));
      lock.setBackground(roundedBackground(R.color.surface_tonal, 34));
      lockPanel.addView(lock, new LinearLayout.LayoutParams(dp(84), dp(84)));
      TextView lockTitle = text("正文已受保护", 20, R.color.text_primary);
      lockTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
      lockTitle.setGravity(Gravity.CENTER);
      lockPanel.addView(lockTitle, matchWrap(0, 22, 0, 8));
      boolean fingerprintReady = biometricStore.isConfiguredFor(protectionKeyring);
      TextView description = text(
        fingerprintReady
          ? "使用手机指纹快速解锁，保护密码和正文不会交给系统。"
          : "输入独立保护密码后，才能在这台设备上查看正文。",
        15,
        R.color.text_secondary
      );
      description.setGravity(Gravity.CENTER);
      description.setLineSpacing(0, 1.25f);
      lockPanel.addView(description, matchWrap(0, 0, 0, 24));
      IconTextButton unlock = primaryIconButton(
        fingerprintReady ? "使用指纹解锁" : getString(R.string.unlock),
        fingerprintReady ? R.drawable.ic_fingerprint : R.drawable.ic_lock
      );
      unlock.setOnClickListener(view -> unlockSelected(null));
      lockPanel.addView(unlock, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        dp(56)
      ));
      if (fingerprintReady) {
        Button passwordUnlock = secondaryButton("改用保护密码");
        passwordUnlock.setOnClickListener(view -> unlockSelectedWithPassword(null));
        lockPanel.addView(passwordUnlock, matchHeight(dp(52), 0, 10, 0, 0));
      }
      paper.addView(lockPanel, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        0,
        1
      ));
    } else {
      bodyField = editText("开始记录…", false);
      bodyField.setGravity(Gravity.TOP | Gravity.START);
      bodyField.setTextSize(17.5f);
      bodyField.setLineSpacing(dp(3), 1.18f);
      bodyField.setText(selectedNote.content.content);
      bodyField.setInputType(
        InputType.TYPE_CLASS_TEXT
          | InputType.TYPE_TEXT_FLAG_MULTI_LINE
          | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
      );
      bodyField.setPadding(dp(20), dp(14), dp(20), dp(20));
      bodyField.setBackgroundColor(Color.TRANSPARENT);
      bodyField.setEnabled(!LOCATION_TRASH.equals(location));
      bodyField.addTextChangedListener(editorWatcher(false));
      paper.addView(bodyField, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        0,
        1
      ));
    }

    LinearLayout.LayoutParams paperParams = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      0,
      1
    );
    paperParams.setMargins(dp(14), dp(4), dp(14), dp(14));
    root.addView(paper, paperParams);

    setContentView(applySystemInsets(root));
    bindingEditor = false;
    ensureAttachmentsLoaded();
  }

  private TextWatcher editorWatcher(boolean title) {
    return new SimpleTextWatcher() {
      @Override public void afterTextChanged(Editable editable) {
        if (bindingEditor || selectedNote == null) return;
        if (title) selectedNote.content.title = editable.toString();
        else selectedNote.content.content = editable.toString();
        markDirty();
      }
    };
  }

  private void markDirty() {
    dirty = true;
    if (saveStatus != null) {
      saveStatus.setText("有未保存更改");
      saveStatus.setTextColor(getColor(R.color.warning));
    }
    if (pendingAutoSave != null) handler.removeCallbacks(pendingAutoSave);
    pendingAutoSave = () -> saveSelected(null);
    handler.postDelayed(pendingAutoSave, AUTO_SAVE_DELAY_MS);
  }

  private void saveSelected(Runnable afterSave) {
    if (selectedNote == null || LOCATION_TRASH.equals(location)) {
      if (afterSave != null) afterSave.run();
      return;
    }
    if (saving) {
      if (afterSave != null) handler.postDelayed(() -> saveSelected(afterSave), 250);
      return;
    }
    if (!dirty) {
      if (afterSave != null) afterSave.run();
      return;
    }
    if (demoMode) {
      saving = true;
      if (saveStatus != null) saveStatus.setText("正在保存…");
      handler.postDelayed(() -> {
        saving = false;
        dirty = false;
        if (selectedNote != null) selectedNote.envelope.revision += 1;
        if (saveStatus != null) {
          saveStatus.setText("已保存");
          saveStatus.setTextColor(getColor(R.color.brand_primary_dark));
        }
        if (afterSave != null) afterSave.run();
      }, 200);
      return;
    }
    handler.removeCallbacksAndMessages(null);
    Models.NoteDocument note = selectedNote;
    String titleSnapshot = note.content.title;
    String bodySnapshot = note.content.content;
    Models.ProtectedBody protectedSnapshot = note.content.protectedContent;
    String attachmentKeySnapshot = note.content.attachmentKey;
    SecretKey protectionSnapshot = protectionKey;
    int revision = note.envelope.revision;
    saving = true;
    if (saveStatus != null) {
      saveStatus.setText("正在加密保存…");
      saveStatus.setTextColor(getColor(R.color.text_secondary));
    }
    runAsync(() -> {
      Models.NoteContent snapshot = new Models.NoteContent(
        titleSnapshot,
        bodySnapshot,
        protectedSnapshot,
        attachmentKeySnapshot
      );
      if (note.envelope.locked && note.unlocked) {
        if (protectionSnapshot == null) throw new IllegalStateException("保护密码需要重新验证。");
        snapshot.protectedContent = CryptoEngine.encryptProtectedBody(
          protectionSnapshot,
          note.envelope.id,
          bodySnapshot,
          attachmentKeySnapshot
        );
      }
      Models.NoteEnvelope updated = api.updateNote(
        CryptoEngine.encryptNote(dataKey, note.envelope.id, snapshot),
        revision
      );
      return new SavedNote(updated, snapshot.protectedContent);
    }, saved -> {
      saving = false;
      copyEnvelope(note.envelope, saved.envelope);
      note.content.protectedContent = saved.protectedContent;
      if (note.content.title.equals(titleSnapshot) && note.content.content.equals(bodySnapshot)) {
        dirty = false;
        if (saveStatus != null) {
          saveStatus.setText("已保存");
          saveStatus.setTextColor(getColor(R.color.brand_primary_dark));
        }
        if (afterSave != null) afterSave.run();
      } else {
        markDirty();
      }
    }, error -> {
      saving = false;
      dirty = true;
      if (saveStatus != null) {
        saveStatus.setText(error instanceof NotesApiClient.ApiException
          && ((NotesApiClient.ApiException) error).status == 409
          ? "版本冲突，请刷新"
          : "保存失败，请重试");
        saveStatus.setTextColor(getColor(R.color.danger));
      }
      showError(error);
    });
  }

  private void closeEditor() {
    keyboard(titleField, false);
    Runnable finish = () -> {
      if (selectedNote != null && selectedNote.envelope.locked && selectedNote.unlocked) {
        selectedNote.content.content = "";
        selectedNote.content.attachmentKey = null;
        selectedNote.unlocked = false;
      }
      clearAttachments();
      protectionKey = null;
      renderHome();
    };
    if (dirty) saveSelected(finish);
    else finish.run();
  }

  private void showEditorActions(View anchor) {
    if (selectedNote == null) return;
    PopupMenu menu = new PopupMenu(this, anchor);
    if (LOCATION_TRASH.equals(location)) {
      menu.getMenu().add(0, 40, 0, "恢复笔记").setIcon(R.drawable.ic_refresh);
      menu.getMenu().add(0, 41, 1, "永久删除").setIcon(R.drawable.ic_trash);
    } else {
      menu.getMenu().add(0, 30, 0, "移动到文件夹").setIcon(R.drawable.ic_folder);
      menu.getMenu().add(0, 31, 1, selectedNote.envelope.locked ? "移除正文保护" : "保护正文").setIcon(R.drawable.ic_lock);
      menu.getMenu().add(0, 32, 2, "移到回收站").setIcon(R.drawable.ic_trash);
    }
    menu.setOnMenuItemClickListener(item -> {
      if (item.getItemId() == 30) showFolderAssignment();
      else if (item.getItemId() == 31) {
        if (selectedNote.envelope.locked) unprotectSelected();
        else protectSelected();
      } else if (item.getItemId() == 32) moveSelectedToTrash();
      else if (item.getItemId() == 40) restoreSelected();
      else if (item.getItemId() == 41) purgeSelected();
      return true;
    });
    menu.show();
  }

  private void showFolderAssignment() {
    String[] names = new String[folders.size() + 1];
    names[0] = "未分类";
    for (int index = 0; index < folders.size(); index++) names[index + 1] = folders.get(index).name;
    new AlertDialog.Builder(this)
      .setTitle("移动到文件夹")
      .setItems(names, (dialog, index) -> {
        String folderId = index == 0 ? null : folders.get(index - 1).envelope.id;
        moveSelected(folderId);
      })
      .setNegativeButton("取消", null)
      .show();
  }

  private void moveSelected(String folderId) {
    if (selectedNote == null) return;
    Models.NoteDocument note = selectedNote;
    saveSelected(() -> {
      setSavingMessage("正在移动…");
      runAsync(
        () -> api.moveNote(note.envelope.id, folderId, note.envelope.revision),
        mutation -> {
          applyMutation(note.envelope, mutation);
          toast("已移动笔记");
          renderEditor();
        }
      );
    });
  }

  private void moveSelectedToTrash() {
    if (selectedNote == null) return;
    Models.NoteDocument note = selectedNote;
    new AlertDialog.Builder(this)
      .setTitle("移到回收站？")
      .setMessage("可以稍后从回收站恢复这条笔记。")
      .setNegativeButton("取消", null)
      .setPositiveButton("移到回收站", (dialog, which) -> saveSelected(() -> {
        showLoading("正在移动到回收站…");
        runAsync(() -> api.moveToTrash(note.envelope.id, note.envelope.revision), mutation -> {
          applyMutation(note.envelope, mutation);
          notes.remove(note);
          trash.add(0, note);
          selectedNote = null;
          renderHome();
        });
      }))
      .show();
  }

  private void restoreSelected() {
    if (selectedNote == null) return;
    Models.NoteDocument note = selectedNote;
    showLoading("正在恢复笔记…");
    runAsync(() -> api.restoreNote(note.envelope.id, note.envelope.revision), mutation -> {
      applyMutation(note.envelope, mutation);
      trash.remove(note);
      notes.add(0, note);
      selectedNote = null;
      renderHome();
    });
  }

  private void purgeSelected() {
    if (selectedNote == null) return;
    Models.NoteDocument note = selectedNote;
    new AlertDialog.Builder(this)
      .setTitle("永久删除？")
      .setMessage("这条笔记将无法恢复。")
      .setNegativeButton("取消", null)
      .setPositiveButton("永久删除", (dialog, which) -> {
        showLoading("正在永久删除…");
        runAsync(() -> {
          api.purgeNote(note.envelope.id, note.envelope.revision);
          return true;
        }, ignored -> {
          attachmentCache.removeNote(note.envelope.id);
          trash.remove(note);
          selectedNote = null;
          renderHome();
        });
      })
      .show();
  }

  private void protectSelected() {
    if (selectedNote == null) return;
    if (protectionKeyring == null) {
      showProtectionDialog(true, credentials -> {
        setSavingMessage("正在设置保护密码…");
        runAsync(() -> {
          CryptoEngine.ProtectionSetup setup = CryptoEngine.createProtectionKeyring(credentials.password);
          Models.ProtectionKeyring stored = api.createProtectionKeyring(setup.payload);
          return new StoredProtection(stored, setup.key);
        }, result -> {
          protectionKeyring = result.keyring;
          protectionKey = result.key;
          applyProtection();
        });
      });
    } else {
      showProtectionDialog(false, credentials -> unlockProtection(credentials.password, this::applyProtection));
    }
  }

  private void applyProtection() {
    if (selectedNote == null || protectionKey == null) return;
    try {
      selectedNote.content.protectedContent = CryptoEngine.encryptProtectedBody(
        protectionKey,
        selectedNote.envelope.id,
        selectedNote.content.content,
        selectedNote.content.attachmentKey
      );
      selectedNote.envelope.locked = true;
      selectedNote.unlocked = true;
      markDirty();
      saveSelected(() -> toast("笔记正文已受保护"));
      renderEditor();
    } catch (Exception error) {
      showError(error);
    }
  }

  private void unlockSelected(Runnable afterUnlock) {
    if (selectedNote == null || protectionKeyring == null) {
      toast("尚未设置保护密码。");
      return;
    }
    if (protectionKey != null) {
      completeSelectedUnlock(afterUnlock);
      return;
    }
    if (biometricStore.isConfiguredFor(protectionKeyring)) {
      biometricStore.unlock(
        protectionKeyring,
        key -> {
          protectionKey = key;
          completeSelectedUnlock(afterUnlock);
        },
        () -> {},
        error -> {
          toast(error.getMessage() == null ? "指纹解锁失败，请使用保护密码。" : error.getMessage());
          renderEditor();
        }
      );
      return;
    }
    unlockSelectedWithPassword(afterUnlock);
  }

  private void unlockSelectedWithPassword(Runnable afterUnlock) {
    showProtectionDialog(false, credentials -> unlockProtection(credentials.password, () -> {
      if (completeSelectedUnlock(afterUnlock) && afterUnlock == null) {
        handler.post(this::maybeOfferBiometricEnrollment);
      }
    }));
  }

  private boolean completeSelectedUnlock(Runnable afterUnlock) {
    if (selectedNote == null || selectedNote.content.protectedContent == null || protectionKey == null) {
      return false;
    }
    try {
      Models.ProtectedPlaintext plaintext = CryptoEngine.decryptProtectedPayload(
        protectionKey,
        selectedNote.envelope.id,
        selectedNote.content.protectedContent
      );
      selectedNote.content.content = plaintext.content;
      selectedNote.content.attachmentKey = plaintext.attachmentKey;
      selectedNote.unlocked = true;
      if (afterUnlock != null) afterUnlock.run();
      else renderEditor();
      return true;
    } catch (Exception error) {
      protectionKey = null;
      showError(error);
      return false;
    }
  }

  private void maybeOfferBiometricEnrollment() {
    if (protectionKey == null || protectionKeyring == null
      || !biometricStore.isAvailable() || biometricStore.isConfiguredFor(protectionKeyring)) return;
    new AlertDialog.Builder(this)
      .setTitle("启用指纹快速解锁？")
      .setMessage("以后可用手机指纹查看所有受保护笔记。本机只保存由 Android Keystore 加密的共享保护密钥，不保存保护密码。")
      .setNegativeButton("以后再说", null)
      .setPositiveButton("启用", (dialog, which) -> enrollBiometric())
      .show();
  }

  private void enrollBiometric() {
    if (protectionKeyring == null || protectionKey == null) {
      toast("请先输入独立保护密码。" );
      return;
    }
    biometricStore.enroll(
      protectionKeyring,
      protectionKey,
      () -> toast("已启用指纹快速解锁"),
      () -> {},
      error -> toast(error.getMessage() == null ? "无法启用指纹解锁。" : error.getMessage())
    );
  }

  private void enableBiometricFromSettings() {
    if (!biometricStore.isAvailable()) {
      toast("请先在手机系统中设置可用的强指纹。" );
      return;
    }
    if (protectionKeyring == null) {
      toast("请先为一条笔记设置独立保护密码。" );
      return;
    }
    showProtectionDialog(false, credentials -> unlockProtection(
      credentials.password,
      this::enrollBiometric
    ));
  }

  private void disableBiometric() {
    new AlertDialog.Builder(this)
      .setTitle("关闭指纹解锁？")
      .setMessage("关闭后仍可使用独立保护密码解锁，不会修改服务端上的加密笔记。")
      .setNegativeButton("取消", null)
      .setPositiveButton("关闭", (dialog, which) -> {
        biometricStore.clear();
        protectionKey = null;
        toast("已关闭指纹快速解锁");
      })
      .show();
  }

  private void unlockProtection(String password, Runnable success) {
    setSavingMessage("正在验证保护密码…");
    runAsync(
      () -> CryptoEngine.unlockProtectionKeyring(protectionKeyring, password),
      key -> {
        protectionKey = key;
        success.run();
      }
    );
  }

  private void unprotectSelected() {
    Runnable removeProtection = () -> {
      if (selectedNote == null) return;
      selectedNote.content.protectedContent = null;
      selectedNote.envelope.locked = false;
      selectedNote.unlocked = false;
      markDirty();
      saveSelected(() -> {
        protectionKey = null;
        toast("已移除正文保护");
      });
      renderEditor();
    };
    if (selectedNote != null && selectedNote.unlocked) removeProtection.run();
    else unlockSelected(removeProtection);
  }

  private void showProtectionDialog(boolean create, Consumer<ProtectionCredentials> completion) {
    LinearLayout fields = verticalLayout(8);
    fields.setPadding(dp(24), dp(8), dp(24), 0);
    TextView label = text(create ? "设置独立保护密码" : "独立保护密码", 14, R.color.text_primary);
    fields.addView(label, matchWrap(0, 0, 0, 4));
    EditText password = editText("至少 12 个字符", true);
    password.setSingleLine(true);
    fields.addView(password, matchHeight(dp(52), 0, 0, 0, 8));
    EditText confirmation = null;
    if (create) {
      TextView confirmationLabel = text("再次输入保护密码", 14, R.color.text_primary);
      fields.addView(confirmationLabel, matchWrap(0, 4, 0, 4));
      confirmation = editText("确认保护密码", true);
      confirmation.setSingleLine(true);
      fields.addView(confirmation, matchHeight(dp(52), 0, 0, 0, 8));
    }
    CheckBox show = new CheckBox(this);
    show.setText(R.string.show_password);
    show.setTextColor(getColor(R.color.text_secondary));
    show.setMinHeight(dp(48));
    EditText finalConfirmation = confirmation;
    show.setOnCheckedChangeListener((button, checked) -> {
      int type = InputType.TYPE_CLASS_TEXT
        | (checked ? InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD : InputType.TYPE_TEXT_VARIATION_PASSWORD);
      password.setInputType(type);
      password.setSelection(password.length());
      if (finalConfirmation != null) {
        finalConfirmation.setInputType(type);
        finalConfirmation.setSelection(finalConfirmation.length());
      }
    });
    fields.addView(show, matchHeight(dp(48), 0, 0, 0, 0));

    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle(create ? "设置笔记保护" : "解锁受保护笔记")
      .setMessage(create ? "所有受保护笔记共用这个密码。密码不会上传或保存在本机。" : null)
      .setView(fields)
      .setNegativeButton("取消", null)
      .setPositiveButton(create ? "设置并保护" : "解锁", null)
      .create();
    dialog.setOnShowListener(ignored -> dialog.getButton(DialogInterface.BUTTON_POSITIVE)
      .setOnClickListener(view -> {
        String value = password.getText().toString();
        if (value.length() < 12) {
          password.setError("保护密码至少需要 12 个字符。");
          return;
        }
        if (finalConfirmation != null && !value.equals(finalConfirmation.getText().toString())) {
          finalConfirmation.setError("两次输入的保护密码不一致。");
          return;
        }
        dialog.dismiss();
        completion.accept(new ProtectionCredentials(value));
      }));
    dialog.show();
  }

  private void startVoiceNote() {
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(
        new String[] { Manifest.permission.RECORD_AUDIO },
        REQUEST_RECORD_AUDIO_PERMISSION
      );
      return;
    }
    beginRecording();
  }

  private void beginRecording() {
    if (recorder != null) return;
    try {
      File directory = new File(getCacheDir(), "voice-captures");
      if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建录音缓存。");
      purgeTemporaryFiles(directory);
      recordingFile = File.createTempFile("voice-", ".m4a", directory);
      recorder = new MediaRecorder(this);
      recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
      recorder.setAudioEncodingBitRate(64_000);
      recorder.setAudioSamplingRate(44_100);
      recorder.setMaxDuration((int) MAX_RECORDING_DURATION_MS);
      recorder.setMaxFileSize(Models.MAX_ATTACHMENT_BYTES);
      recorder.setOutputFile(recordingFile);
      recorder.setOnInfoListener((source, what, extra) -> {
        if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED
          || what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED) {
          handler.post(() -> finishRecording(true, true));
        }
      });
      recorder.prepare();
      recorder.start();
      recordingStartedAt = SystemClock.elapsedRealtime();
      showRecordingDialog();
    } catch (Exception error) {
      discardActiveRecording();
      showError(error);
    }
  }

  private void showRecordingDialog() {
    LinearLayout panel = verticalLayout(0);
    panel.setGravity(Gravity.CENTER);
    panel.setPadding(dp(28), dp(24), dp(28), dp(10));
    ImageView mic = iconView(R.drawable.ic_mic, R.color.warning, "正在录音", 34);
    mic.setPadding(dp(20), dp(20), dp(20), dp(20));
    mic.setBackground(roundedBackground(R.color.surface_tonal, 38));
    panel.addView(mic, new LinearLayout.LayoutParams(dp(84), dp(84)));
    TextView title = text("正在录音", 20, R.color.text_primary);
    title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    title.setGravity(Gravity.CENTER);
    panel.addView(title, matchWrap(0, 18, 0, 4));
    recordingTime = text("00:00 / 05:00", 16, R.color.text_secondary);
    recordingTime.setGravity(Gravity.CENTER);
    panel.addView(recordingTime, matchWrap(0, 0, 0, 4));
    TextView privacy = text("原声只暂存在本机，完成后加密同步；不会转换成文字。", 13, R.color.text_secondary);
    privacy.setGravity(Gravity.CENTER);
    panel.addView(privacy, matchWrap(0, 4, 0, 4));

    recordingDialog = new AlertDialog.Builder(this)
      .setView(panel)
      .setNegativeButton("取消", null)
      .setPositiveButton("完成录音", null)
      .setCancelable(false)
      .create();
    recordingDialog.setOnShowListener(ignored -> {
      recordingDialog.getButton(DialogInterface.BUTTON_NEGATIVE)
        .setOnClickListener(view -> finishRecording(false, false));
      recordingDialog.getButton(DialogInterface.BUTTON_POSITIVE)
        .setOnClickListener(view -> finishRecording(true, false));
    });
    recordingDialog.show();
    recordingTicker = new Runnable() {
      @Override public void run() {
        if (recorder == null || recordingTime == null) return;
        long elapsed = Math.min(MAX_RECORDING_DURATION_MS,
          SystemClock.elapsedRealtime() - recordingStartedAt);
        recordingTime.setText(formatDuration(elapsed) + " / 05:00");
        handler.postDelayed(this, 250);
      }
    };
    handler.post(recordingTicker);
  }

  private void finishRecording(boolean keep, boolean reachedLimit) {
    if (recorder == null) return;
    long duration = Math.min(MAX_RECORDING_DURATION_MS,
      Math.max(0, SystemClock.elapsedRealtime() - recordingStartedAt));
    File completed = recordingFile;
    MediaRecorder active = recorder;
    recorder = null;
    recordingFile = null;
    if (recordingTicker != null) handler.removeCallbacks(recordingTicker);
    recordingTicker = null;
    try {
      active.stop();
    } catch (RuntimeException error) {
      keep = false;
    } finally {
      active.release();
    }
    if (recordingDialog != null) recordingDialog.dismiss();
    recordingDialog = null;
    recordingTime = null;
    if (!keep || duration < 500) {
      deleteTemporaryFile(completed);
      if (keep) toast("录音时间太短，请重新录制。");
      return;
    }
    final int durationMillis = (int) duration;
    runAsync(() -> {
      try {
        byte[] bytes = Files.readAllBytes(completed.toPath());
        if (bytes.length == 0 || bytes.length > Models.MAX_ATTACHMENT_BYTES) {
          throw new IllegalArgumentException("单段录音不能超过 10 MiB。");
        }
        return new SelectedMedia(bytes, "audio/mp4", 1, 1, durationMillis);
      } finally {
        deleteTemporaryFile(completed);
      }
    }, media -> {
      if (reachedLimit) toast("录音已达到安全上限并自动结束。");
      createNote(captureTitle("语音记事"), false, note -> {
        note.content.attachmentKey = CryptoEngine.createMediaKey();
        markDirty();
        saveSelected(() -> uploadAttachment(note, media));
      });
    });
  }

  private void discardActiveRecording() {
    if (recorder == null) {
      deleteTemporaryFile(recordingFile);
      recordingFile = null;
      return;
    }
    MediaRecorder active = recorder;
    recorder = null;
    try { active.stop(); } catch (Exception ignored) {}
    active.release();
    deleteTemporaryFile(recordingFile);
    recordingFile = null;
    if (recordingDialog != null) recordingDialog.dismiss();
    recordingDialog = null;
  }

  private void startPhotoNote() {
    Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
    if (intent.resolveActivity(getPackageManager()) == null) {
      toast("没有找到可用的相机应用。");
      return;
    }
    try {
      File directory = new File(getCacheDir(), "camera-captures");
      if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建拍照缓存。");
      purgeTemporaryFiles(directory);
      File target = File.createTempFile("photo-", ".jpg", directory);
      Uri uri = CameraFileProvider.uriFor(this, target);
      pendingCameraPath = target.getAbsolutePath();
      intent.putExtra(MediaStore.EXTRA_OUTPUT, uri);
      intent.setClipData(ClipData.newRawUri("My Notes photo", uri));
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
      startActivityForResult(intent, REQUEST_CAMERA);
    } catch (Exception error) {
      if (pendingCameraPath != null) deleteTemporaryFile(new File(pendingCameraPath));
      pendingCameraPath = null;
      showError(error);
    }
  }

  private void chooseImage() {
    if (selectedNote == null || LOCATION_TRASH.equals(location)) return;
    if (selectedNote.envelope.locked && !selectedNote.unlocked) {
      toast("请先解锁受保护笔记。");
      return;
    }
    if (attachments.size() >= 20) {
      toast("每篇笔记最多添加 20 个附件。");
      return;
    }
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType("image/*");
    intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
      "image/jpeg", "image/png", "image/webp"
    });
    startActivityForResult(intent, REQUEST_IMAGE);
  }

  private void importImage(Uri uri, Runnable cleanup) {
    Models.NoteDocument note = selectedNote;
    if (note == null) return;
    setSavingMessage("正在读取图片…");
    runAsync(() -> {
      String type = getContentResolver().getType(uri);
      if ("image/jpg".equals(type)) type = "image/jpeg";
      if (!("image/jpeg".equals(type) || "image/png".equals(type) || "image/webp".equals(type))) {
        throw new IllegalArgumentException("仅支持 JPEG、PNG 和 WebP 图片。");
      }
      byte[] bytes;
      try (InputStream input = getContentResolver().openInputStream(uri)) {
        bytes = readBoundedImage(input);
      }
      BitmapFactory.Options bounds = new BitmapFactory.Options();
      bounds.inJustDecodeBounds = true;
      BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
        throw new IllegalArgumentException("无法识别这张图片。");
      }
      return new SelectedMedia(bytes, type, bounds.outWidth, bounds.outHeight, 0);
    }, image -> {
      if (cleanup != null) cleanup.run();
      if (selectedNote != note) {
        return;
      }
      if (note.content.attachmentKey == null) {
        note.content.attachmentKey = CryptoEngine.createMediaKey();
        markDirty();
      }
      saveSelected(() -> uploadAttachment(note, image));
    }, error -> {
      if (cleanup != null) cleanup.run();
      showError(error);
    });
  }

  private void uploadAttachment(Models.NoteDocument note, SelectedMedia media) {
    uploadAttachment(note, media, null);
  }

  private void uploadAttachment(Models.NoteDocument note, SelectedMedia media, Runnable cleanup) {
    if (selectedNote != note || note.content.attachmentKey == null) return;
    String attachmentId = UUID.randomUUID().toString();
    boolean audio = "audio/mp4".equals(media.contentType);
    setSavingMessage(audio ? "正在加密上传录音…" : "正在加密上传图片…");
    runAsync(() -> {
      CryptoEngine.EncryptedAttachment encrypted = CryptoEngine.encryptAttachment(
        media.bytes,
        media.contentType,
        media.width,
        media.height,
        media.durationMillis,
        note.envelope.id,
        attachmentId,
        note.envelope.locked,
        note.content.attachmentKey
      );
      Models.AttachmentEnvelope envelope;
      if (demoMode) {
        envelope = new Models.AttachmentEnvelope(
          attachmentId,
          note.envelope.id,
          1,
          1,
          encrypted.payload.getString("ciphertext"),
          encrypted.payload.getString("nonce"),
          note.envelope.locked,
          encrypted.body.length,
          java.time.Instant.now().toString(),
          java.time.Instant.now().toString()
        );
      } else {
        envelope = api.uploadAttachment(encrypted.payload, encrypted.body);
      }
      attachmentCache.write(envelope, encrypted.body);
      return new Models.AttachmentDocument(envelope, encrypted.metadata, media.bytes);
    }, document -> {
      if (cleanup != null) cleanup.run();
      if (selectedNote != note) return;
      for (Models.AttachmentDocument item : attachments) item.mediaData = null;
      attachments.add(document);
      attachmentsNoteId = note.envelope.id;
      renderAttachmentGallery();
      if (saveStatus != null) {
        saveStatus.setText(audio ? "录音已加密保存" : "图片已加密保存");
        saveStatus.setTextColor(getColor(R.color.brand_primary_dark));
      }
    }, error -> {
      if (cleanup != null) cleanup.run();
      showError(error);
    });
  }

  private void ensureAttachmentsLoaded() {
    Models.NoteDocument note = selectedNote;
    if (note == null || (note.envelope.locked && !note.unlocked)) return;
    if (note.envelope.id.equals(attachmentsNoteId)) return;
    attachments.clear();
    attachmentsNoteId = note.envelope.id;
    if (note.content.attachmentKey == null || demoMode) {
      renderAttachmentGallery();
      return;
    }
    attachmentsLoading = true;
    renderAttachmentGallery();
    String mediaKey = note.content.attachmentKey;
    runAsync(() -> {
      List<Models.AttachmentDocument> result = new ArrayList<>();
      List<Models.AttachmentEnvelope> envelopes = api.listAttachments(note.envelope.id);
      attachmentCache.retain(note.envelope.id, envelopes);
      for (Models.AttachmentEnvelope envelope : envelopes) {
        result.add(new Models.AttachmentDocument(
          envelope,
          CryptoEngine.decryptAttachmentMetadata(mediaKey, envelope),
          null
        ));
      }
      return result;
    }, loaded -> {
      if (selectedNote != note || !note.envelope.id.equals(attachmentsNoteId)) return;
      attachmentsLoading = false;
      attachments.clear();
      attachments.addAll(loaded);
      renderAttachmentGallery();
    }, error -> {
      attachmentsLoading = false;
      renderAttachmentGallery();
      showError(error);
    });
  }

  private void renderAttachmentGallery() {
    if (attachmentGallery == null || attachmentScroller == null) return;
    attachmentGallery.removeAllViews();
    if (attachmentsLoading) {
      TextView loading = text("正在读取加密附件…", 14, R.color.text_secondary);
      loading.setGravity(Gravity.CENTER);
      attachmentGallery.addView(loading, new LinearLayout.LayoutParams(dp(220), dp(112)));
      attachmentScroller.setVisibility(View.VISIBLE);
      return;
    }
    if (attachments.isEmpty()) {
      attachmentScroller.setVisibility(View.GONE);
      return;
    }
    attachmentScroller.setVisibility(View.VISIBLE);
    for (Models.AttachmentDocument document : attachments) {
      boolean audio = document.isAudio();
      LinearLayout card = verticalLayout(0);
      card.setPadding(dp(6), dp(6), dp(6), dp(5));
      card.setBackground(roundedStrokeBackground(R.color.surface_variant, R.color.divider, 16, 1));
      card.setContentDescription(audio ? "加密录音附件" : "加密图片附件");

      FrameLayout preview = new FrameLayout(this);
      preview.setBackground(rippleBackground(R.color.surface, 12));
      if (audio) {
        LinearLayout audioPanel = verticalLayout(0);
        audioPanel.setGravity(Gravity.CENTER);
        boolean playing = document.envelope.id.equals(playingAttachmentId)
          && audioPlayer != null && audioPlayer.isPlaying();
        ImageView icon = iconView(
          playing ? R.drawable.ic_pause : R.drawable.ic_play,
          R.color.brand_primary_dark,
          playing ? "暂停录音" : "播放录音",
          26
        );
        icon.setPadding(dp(10), dp(10), dp(10), dp(10));
        icon.setBackground(roundedBackground(R.color.surface_tonal, 24));
        audioPanel.addView(icon, new LinearLayout.LayoutParams(dp(52), dp(52)));
        TextView label = text(
          playing ? "正在播放" : "语音 · " + formatDuration(document.metadata.durationMillis),
          12,
          R.color.text_secondary
        );
        label.setGravity(Gravity.CENTER);
        audioPanel.addView(label, matchWrap(0, 4, 0, 0));
        preview.addView(audioPanel, frameMatch());
      } else if (document.mediaData == null) {
        LinearLayout placeholder = verticalLayout(0);
        placeholder.setGravity(Gravity.CENTER);
        ImageView icon = iconView(R.drawable.ic_image_add, R.color.brand_primary_dark, null, 24);
        placeholder.addView(icon, new LinearLayout.LayoutParams(dp(34), dp(34)));
        TextView label = text("点击解密", 12, R.color.text_secondary);
        label.setGravity(Gravity.CENTER);
        placeholder.addView(label, matchWrap(0, 2, 0, 0));
        preview.addView(placeholder, frameMatch());
      } else {
        ImageView image = new ImageView(this);
        image.setScaleType(ImageView.ScaleType.CENTER_CROP);
        image.setImageBitmap(decodeCardBitmap(document.mediaData));
        preview.addView(image, frameMatch());
      }
      preview.setOnClickListener(view -> {
        if (document.mediaData == null) loadAttachmentMedia(document);
        else if (audio) playAudioAttachment(document);
        else showAttachmentPreview(document);
      });
      card.addView(preview, new LinearLayout.LayoutParams(dp(126), dp(82)));

      LinearLayout footer = horizontalLayout(Gravity.CENTER_VERTICAL);
      TextView size = text(formatBytes(document.metadata.plaintextBytes), 11, R.color.text_secondary);
      footer.addView(size, new LinearLayout.LayoutParams(0, dp(30), 1));
      ImageButton delete = iconButton(R.drawable.ic_trash, audio ? "删除录音" : "删除图片", false);
      delete.setPadding(dp(7), dp(7), dp(7), dp(7));
      delete.setOnClickListener(view -> confirmDeleteAttachment(document));
      footer.addView(delete, new LinearLayout.LayoutParams(dp(34), dp(34)));
      card.addView(footer, new LinearLayout.LayoutParams(dp(126), dp(34)));

      LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(dp(138), dp(122));
      cardParams.setMargins(dp(4), 0, dp(4), 0);
      attachmentGallery.addView(card, cardParams);
    }
  }

  private void loadAttachmentMedia(Models.AttachmentDocument document) {
    Models.NoteDocument note = selectedNote;
    if (note == null) return;
    setSavingMessage(document.isAudio() ? "正在下载并解密录音…" : "正在下载并解密图片…");
    runAsync(() -> {
      byte[] encrypted = attachmentCache.read(document.envelope);
      if (encrypted != null) {
        try {
          return CryptoEngine.decryptAttachmentBody(
            encrypted,
            document.envelope,
            document.metadata
          );
        } catch (Exception ignored) {
          attachmentCache.remove(document.envelope);
        }
      }
      encrypted = api.downloadAttachment(note.envelope.id, document.envelope.id);
      byte[] decrypted = CryptoEngine.decryptAttachmentBody(
        encrypted,
        document.envelope,
        document.metadata
      );
      attachmentCache.write(document.envelope, encrypted);
      return decrypted;
    }, bytes -> {
      if (selectedNote != note || !attachments.contains(document)) return;
      for (Models.AttachmentDocument item : attachments) {
        if (!item.envelope.id.equals(playingAttachmentId)) item.mediaData = null;
      }
      document.mediaData = bytes;
      renderAttachmentGallery();
      if (saveStatus != null) saveStatus.setText(saveStatusText());
      if (document.isAudio()) playAudioAttachment(document);
      else showAttachmentPreview(document);
    });
  }

  private void showAttachmentPreview(Models.AttachmentDocument document) {
    if (document.mediaData == null || document.isAudio()) return;
    ImageView image = new ImageView(this);
    image.setAdjustViewBounds(true);
    image.setScaleType(ImageView.ScaleType.FIT_CENTER);
    image.setImageBitmap(BitmapFactory.decodeByteArray(
      document.mediaData,
      0,
      document.mediaData.length
    ));
    int padding = dp(12);
    FrameLayout wrapper = new FrameLayout(this);
    wrapper.setPadding(padding, padding, padding, padding);
    wrapper.addView(image, frameMatch());
    new AlertDialog.Builder(this)
      .setTitle("加密图片")
      .setView(wrapper)
      .setPositiveButton("关闭", null)
      .show();
  }

  private void playAudioAttachment(Models.AttachmentDocument document) {
    if (!document.isAudio() || document.mediaData == null) return;
    if (document.envelope.id.equals(playingAttachmentId) && audioPlayer != null) {
      if (audioPlayer.isPlaying()) audioPlayer.pause();
      else audioPlayer.start();
      renderAttachmentGallery();
      return;
    }
    if (document.envelope.id.equals(pendingPlaybackAttachmentId)) return;
    stopAudioPlayback();
    pendingPlaybackAttachmentId = document.envelope.id;
    setSavingMessage("正在准备播放录音…");
    byte[] audioBytes = document.mediaData;
    runAsync(() -> {
      File directory = new File(getCacheDir(), "audio-playback");
      if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建播放缓存。");
      File temporary = File.createTempFile("play-", ".m4a", directory);
      try (FileOutputStream output = new FileOutputStream(temporary)) {
        output.write(audioBytes);
      }
      return temporary;
    }, temporary -> {
      if (!document.envelope.id.equals(pendingPlaybackAttachmentId)
        || selectedNote == null || !attachments.contains(document)) {
        deleteTemporaryFile(temporary);
        return;
      }
      pendingPlaybackAttachmentId = null;
      playbackFile = temporary;
      try {
      MediaPlayer player = new MediaPlayer();
      player.setDataSource(playbackFile.getAbsolutePath());
      player.setOnPreparedListener(prepared -> {
        if (prepared != audioPlayer) return;
        prepared.start();
        if (saveStatus != null) saveStatus.setText(saveStatusText());
        renderAttachmentGallery();
      });
      player.setOnCompletionListener(ignored -> {
        stopAudioPlayback();
        renderAttachmentGallery();
      });
      player.setOnErrorListener((ignored, what, extra) -> {
        stopAudioPlayback();
        toast("无法播放这段录音。");
        renderAttachmentGallery();
        return true;
      });
      audioPlayer = player;
      playingAttachmentId = document.envelope.id;
      player.prepareAsync();
      } catch (Exception error) {
        stopAudioPlayback();
        showError(error);
      }
    }, error -> {
      pendingPlaybackAttachmentId = null;
      stopAudioPlayback();
      showError(error);
    });
  }

  private void stopAudioPlayback() {
    if (audioPlayer != null) {
      try { audioPlayer.stop(); } catch (Exception ignored) {}
      audioPlayer.release();
    }
    audioPlayer = null;
    playingAttachmentId = null;
    pendingPlaybackAttachmentId = null;
    deleteQuietly(playbackFile);
    playbackFile = null;
  }

  private void confirmDeleteAttachment(Models.AttachmentDocument document) {
    new AlertDialog.Builder(this)
      .setTitle(document.isAudio() ? "删除这段录音？" : "删除这张图片？")
      .setMessage("附件会从云端永久删除，无法恢复。")
      .setNegativeButton("取消", null)
      .setPositiveButton("删除", (dialog, which) -> {
        Models.NoteDocument note = selectedNote;
        if (note == null) return;
        if (demoMode) {
          attachmentCache.remove(document.envelope);
          attachments.remove(document);
          renderAttachmentGallery();
          return;
        }
        setSavingMessage("正在删除附件…");
        runAsync(() -> {
          api.deleteAttachment(note.envelope.id, document.envelope.id, document.envelope.revision);
          return true;
        }, ignored -> {
          attachmentCache.remove(document.envelope);
          attachments.remove(document);
          renderAttachmentGallery();
          if (document.envelope.id.equals(playingAttachmentId)) stopAudioPlayback();
          if (saveStatus != null) saveStatus.setText("附件已删除");
        });
      })
      .show();
  }

  private byte[] readBoundedImage(InputStream input) throws Exception {
    if (input == null) throw new IllegalArgumentException("无法读取这张图片。");
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[16 * 1024];
    int count;
    while ((count = input.read(buffer)) != -1) {
      if (output.size() + count > Models.MAX_ATTACHMENT_BYTES) {
        throw new IllegalArgumentException("单张图片不能超过 10 MiB。");
      }
      output.write(buffer, 0, count);
    }
    if (output.size() == 0) throw new IllegalArgumentException("图片内容为空。");
    return output.toByteArray();
  }

  private android.graphics.Bitmap decodeCardBitmap(byte[] bytes) {
    BitmapFactory.Options bounds = new BitmapFactory.Options();
    bounds.inJustDecodeBounds = true;
    BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
    int sample = 1;
    while (bounds.outWidth / sample > 512 || bounds.outHeight / sample > 512) sample *= 2;
    BitmapFactory.Options options = new BitmapFactory.Options();
    options.inSampleSize = sample;
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
  }

  private String formatBytes(int bytes) {
    if (bytes < 1024 * 1024) return String.format(Locale.getDefault(), "%.1f KB", bytes / 1024f);
    return String.format(Locale.getDefault(), "%.1f MB", bytes / (1024f * 1024f));
  }

  private String formatDuration(long millis) {
    long seconds = Math.max(0, millis / 1000);
    return String.format(Locale.getDefault(), "%02d:%02d", seconds / 60, seconds % 60);
  }

  private String captureTitle(String prefix) {
    return prefix + " " + new SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(new Date());
  }

  private static void deleteQuietly(File file) {
    if (file == null || !file.exists()) return;
    if (file.delete()) return;
    try { Files.deleteIfExists(file.toPath()); } catch (Exception ignored) {}
  }

  private void deleteTemporaryFile(File file) {
    deleteTemporaryFile(file, 6);
  }

  private void deleteTemporaryFile(File file, int attemptsRemaining) {
    deleteQuietly(file);
    if (file == null || !file.exists() || attemptsRemaining <= 1) return;
    handler.postDelayed(() -> deleteTemporaryFile(file, attemptsRemaining - 1), 250);
  }

  private static void purgeTemporaryFiles(File directory) {
    File[] files = directory.listFiles();
    if (files == null) return;
    for (File file : files) {
      if (file.isFile()) deleteQuietly(file);
    }
  }

  private void clearAttachments() {
    stopAudioPlayback();
    attachments.clear();
    attachmentsNoteId = null;
    attachmentsLoading = false;
    attachmentScroller = null;
    attachmentGallery = null;
  }

  private void createFolder() {
    EditText name = editText("文件夹名称", false);
    name.setSingleLine(true);
    int padding = dp(24);
    FrameLayout wrapper = new FrameLayout(this);
    wrapper.setPadding(padding, dp(8), padding, 0);
    wrapper.addView(name, frameHeight(dp(52)));
    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("新建文件夹")
      .setView(wrapper)
      .setNegativeButton("取消", null)
      .setPositiveButton("创建", null)
      .create();
    dialog.setOnShowListener(ignored -> dialog.getButton(DialogInterface.BUTTON_POSITIVE)
      .setOnClickListener(view -> {
        String value = name.getText().toString().trim();
        if (value.isEmpty()) {
          name.setError("请输入文件夹名称。");
          return;
        }
        dialog.dismiss();
        String id = UUID.randomUUID().toString();
        showLoading("正在创建文件夹…");
        runAsync(() -> {
          Models.FolderEnvelope envelope = api.createFolder(CryptoEngine.encryptFolder(dataKey, id, value));
          return new Models.FolderDocument(envelope, value);
        }, folder -> {
          folders.add(folder);
          location = LOCATION_FOLDER_PREFIX + folder.envelope.id;
          renderHome();
        });
      }));
    dialog.show();
  }

  private void manageFolders() {
    LinearLayout rows = verticalLayout(4);
    rows.setPadding(dp(12), dp(4), dp(12), dp(4));
    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("文件夹排序与管理")
      .setMessage("使用箭头手动调整文件夹顺序；点击名称可重命名或删除。")
      .setView(rows)
      .setNegativeButton("完成", null)
      .create();
    for (int index = 0; index < folders.size(); index++) {
      Models.FolderDocument folder = folders.get(index);
      LinearLayout row = horizontalLayout(Gravity.CENTER_VERTICAL);
      row.setPadding(dp(6), dp(2), dp(2), dp(2));
      row.setBackground(roundedBackground(R.color.surface_variant, 14));

      TextView name = text(folder.name, 16, R.color.text_primary);
      name.setSingleLine(true);
      name.setPadding(dp(12), 0, dp(8), 0);
      name.setBackground(rippleBackground(R.color.surface_variant, 12));
      name.setOnClickListener(view -> {
        dialog.dismiss();
        showFolderActions(folder);
      });
      row.addView(name, new LinearLayout.LayoutParams(0, dp(52), 1));

      ImageButton up = iconButton(R.drawable.ic_arrow_up, "上移 " + folder.name, false);
      up.setEnabled(index > 0);
      up.setAlpha(index > 0 ? 1f : 0.32f);
      up.setOnClickListener(view -> {
        dialog.dismiss();
        moveFolder(folder, -1);
      });
      row.addView(up, new LinearLayout.LayoutParams(dp(48), dp(48)));

      ImageButton down = iconButton(R.drawable.ic_arrow_down, "下移 " + folder.name, false);
      down.setEnabled(index < folders.size() - 1);
      down.setAlpha(index < folders.size() - 1 ? 1f : 0.32f);
      down.setOnClickListener(view -> {
        dialog.dismiss();
        moveFolder(folder, 1);
      });
      row.addView(down, new LinearLayout.LayoutParams(dp(48), dp(48)));
      rows.addView(row, matchHeight(dp(56), 0, 3, 0, 3));
    }
    dialog.show();
  }

  private void showChangePasswordDialog() {
    if (user == null) return;
    LinearLayout fields = verticalLayout(8);
    fields.setPadding(dp(24), dp(8), dp(24), 0);
    EditText current = editText("当前登录密码", true);
    current.setSingleLine(true);
    fields.addView(current, matchHeight(dp(52), 0, 0, 0, 8));
    EditText updated = editText("新密码（至少 12 个字符）", true);
    updated.setSingleLine(true);
    fields.addView(updated, matchHeight(dp(52), 0, 0, 0, 8));
    EditText confirmation = editText("再次输入新密码", true);
    confirmation.setSingleLine(true);
    fields.addView(confirmation, matchHeight(dp(52), 0, 0, 0, 8));

    CheckBox show = new CheckBox(this);
    show.setText(R.string.show_password);
    show.setTextColor(getColor(R.color.text_secondary));
    show.setMinHeight(dp(48));
    show.setOnCheckedChangeListener((button, checked) -> {
      int type = InputType.TYPE_CLASS_TEXT
        | (checked ? InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD : InputType.TYPE_TEXT_VARIATION_PASSWORD);
      current.setInputType(type);
      updated.setInputType(type);
      confirmation.setInputType(type);
      current.setSelection(current.length());
      updated.setSelection(updated.length());
      confirmation.setSelection(confirmation.length());
    });
    fields.addView(show, matchHeight(dp(48), 0, 0, 0, 0));

    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("修改登录密码")
      .setMessage("修改后其他设备保存的长期 Token 会立即失效。")
      .setView(fields)
      .setNegativeButton("取消", null)
      .setPositiveButton("修改密码", null)
      .create();
    dialog.setOnShowListener(ignored -> dialog.getButton(DialogInterface.BUTTON_POSITIVE)
      .setOnClickListener(view -> {
        String currentValue = current.getText().toString();
        String updatedValue = updated.getText().toString();
        if (currentValue.isEmpty()) {
          current.setError("请输入当前登录密码。");
          return;
        }
        if (updatedValue.length() < 12) {
          updated.setError("新密码至少需要 12 个字符。");
          return;
        }
        if (updatedValue.equals(currentValue)) {
          updated.setError("新密码不能与当前密码相同。");
          return;
        }
        if (!updatedValue.equals(confirmation.getText().toString())) {
          confirmation.setError("两次输入的新密码不一致。");
          return;
        }
        String username = user.username;
        dialog.dismiss();
        showLoading("正在修改登录密码…");
        runAsync(
          () -> api.changePassword(username, currentValue, updatedValue),
          changedUser -> {
            user = changedUser;
            toast("登录密码已修改");
            renderHome();
          },
          error -> {
            renderHome();
            toast(error.getMessage() == null ? "修改密码失败，请重试。" : error.getMessage());
          }
        );
      }));
    dialog.show();
  }

  private void showFolderActions(Models.FolderDocument folder) {
    int index = folders.indexOf(folder);
    LinearLayout actions = verticalLayout(4);
    actions.setPadding(dp(16), dp(4), dp(16), dp(4));
    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle(folder.name)
      .setView(actions)
      .setNegativeButton("取消", null)
      .create();
    addFolderActionRow(
      actions,
      "上移",
      R.drawable.ic_arrow_up,
      index > 0,
      false,
      () -> { dialog.dismiss(); moveFolder(folder, -1); }
    );
    addFolderActionRow(
      actions,
      "下移",
      R.drawable.ic_arrow_down,
      index >= 0 && index < folders.size() - 1,
      false,
      () -> { dialog.dismiss(); moveFolder(folder, 1); }
    );
    addFolderActionRow(
      actions,
      "重命名",
      R.drawable.ic_edit,
      true,
      false,
      () -> { dialog.dismiss(); renameFolder(folder); }
    );
    addFolderActionRow(
      actions,
      "删除文件夹",
      R.drawable.ic_trash,
      true,
      true,
      () -> { dialog.dismiss(); confirmDeleteFolder(folder); }
    );
    dialog.show();
  }

  private void addFolderActionRow(
    LinearLayout container,
    String label,
    int iconRes,
    boolean enabled,
    boolean destructive,
    Runnable action
  ) {
    TextView row = text(label, 16, destructive ? R.color.danger : R.color.text_primary);
    row.setPadding(dp(16), 0, dp(16), 0);
    row.setMinHeight(dp(52));
    row.setClickable(enabled);
    row.setFocusable(enabled);
    row.setEnabled(enabled);
    row.setAlpha(enabled ? 1f : 0.38f);
    row.setBackground(rippleBackground(R.color.surface, 14));
    Drawable icon = getDrawable(iconRes).mutate();
    icon.setTint(getColor(destructive ? R.color.danger : R.color.text_secondary));
    icon.setBounds(0, 0, dp(22), dp(22));
    row.setCompoundDrawablePadding(dp(14));
    row.setCompoundDrawables(icon, null, null, null);
    if (enabled) row.setOnClickListener(view -> action.run());
    container.addView(row, matchHeight(52, 0, 0, 0, 0));
  }

  private void moveFolder(Models.FolderDocument folder, int offset) {
    int source = folders.indexOf(folder);
    int destination = source + offset;
    if (source < 0 || destination < 0 || destination >= folders.size()) return;
    List<Models.FolderDocument> previous = new ArrayList<>(folders);
    List<Models.FolderDocument> ordered = new ArrayList<>(previous);
    Collections.swap(ordered, source, destination);
    folders.clear();
    folders.addAll(ordered);
    renderHome();
    if (demoMode) {
      return;
    }
    long generation = ++folderOrderGeneration;
    List<String> folderIds = new ArrayList<>();
    for (Models.FolderDocument item : ordered) folderIds.add(item.envelope.id);
    runAsync(() -> {
      api.reorderFolders(folderIds);
      return true;
    }, ignored -> {
      if (generation == folderOrderGeneration) {
        Toast.makeText(this, "文件夹顺序已同步", Toast.LENGTH_SHORT).show();
      }
    }, error -> {
      if (generation == folderOrderGeneration) {
        folders.clear();
        folders.addAll(previous);
        renderHome();
        toast("文件夹排序同步失败，已恢复原顺序：" + error.getMessage());
      }
    });
  }

  private void renameFolder(Models.FolderDocument folder) {
    EditText name = editText("文件夹名称", false);
    name.setSingleLine(true);
    name.setText(folder.name);
    name.selectAll();
    FrameLayout wrapper = new FrameLayout(this);
    wrapper.setPadding(dp(24), dp(8), dp(24), 0);
    wrapper.addView(name, frameHeight(dp(52)));
    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("重命名文件夹")
      .setView(wrapper)
      .setNegativeButton("取消", null)
      .setPositiveButton("保存", null)
      .create();
    dialog.setOnShowListener(ignored -> dialog.getButton(DialogInterface.BUTTON_POSITIVE)
      .setOnClickListener(view -> {
        String value = name.getText().toString().trim();
        if (value.isEmpty()) {
          name.setError("请输入文件夹名称。");
          return;
        }
        dialog.dismiss();
        if (demoMode) {
          folder.name = value;
          renderHome();
          return;
        }
        showLoading("正在重命名文件夹…");
        runAsync(() -> api.updateFolder(
          CryptoEngine.encryptFolder(dataKey, folder.envelope.id, value),
          folder.envelope.revision
        ), updated -> {
          folder.envelope.revision = updated.revision;
          folder.envelope.ciphertext = updated.ciphertext;
          folder.envelope.nonce = updated.nonce;
          folder.envelope.updatedAt = updated.updatedAt;
          folder.name = value;
          renderHome();
        });
      }));
    dialog.show();
  }

  private void confirmDeleteFolder(Models.FolderDocument folder) {
    new AlertDialog.Builder(this)
      .setTitle("删除“" + folder.name + "”？")
      .setMessage("文件夹中的笔记会移动到未分类，不会被删除。")
      .setNegativeButton("取消", null)
      .setPositiveButton("删除文件夹", (dialog, which) -> {
        if (demoMode) {
          for (Models.NoteDocument note : notes) {
            if (folder.envelope.id.equals(note.envelope.folderId)) {
              note.envelope.folderId = null;
              note.envelope.revision += 1;
            }
          }
          folders.remove(folder);
          if (location.equals(LOCATION_FOLDER_PREFIX + folder.envelope.id)) location = LOCATION_ALL;
          renderHome();
          return;
        }
        showLoading("正在删除文件夹…");
        runAsync(() -> {
          api.deleteFolder(folder.envelope.id, folder.envelope.revision);
          return true;
        }, ignored -> {
          if (location.equals(LOCATION_FOLDER_PREFIX + folder.envelope.id)) location = LOCATION_ALL;
          loadAllData();
        });
      })
      .show();
  }

  private void logout() {
    showLoading("正在退出登录…");
    runAsync(() -> {
      api.logout();
      return true;
    }, ignored -> {
      clearState();
      showLogin();
    });
  }

  private void clearState() {
    user = null;
    dataKey = null;
    protectionKeyring = null;
    protectionKey = null;
    selectedNote = null;
    clearAttachments();
    notes.clear();
    trash.clear();
    folders.clear();
    searchQuery = "";
    location = LOCATION_ALL;
    handler.removeCallbacksAndMessages(null);
    dirty = false;
    saving = false;
  }

  private void showLoading(String message) {
    editorVisible = false;
    LinearLayout content = verticalLayout(0);
    content.setGravity(Gravity.CENTER);
    content.setBackgroundColor(getColor(R.color.background));
    ImageView icon = iconView(R.drawable.ic_note, R.color.on_brand, "My Notes", 26);
    icon.setPadding(dp(14), dp(14), dp(14), dp(14));
    icon.setBackground(roundedBackground(R.color.brand_primary, 18));
    content.addView(icon, new LinearLayout.LayoutParams(dp(60), dp(60)));
    ProgressBar progress = new ProgressBar(this);
    progress.setIndeterminateTintList(ColorStateList.valueOf(getColor(R.color.brand_primary)));
    LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(dp(40), dp(40));
    progressParams.setMargins(0, dp(22), 0, dp(8));
    content.addView(progress, progressParams);
    TextView label = text(message, 16, R.color.text_secondary);
    label.setGravity(Gravity.CENTER);
    content.addView(label, matchWrap(24, 0, 24, 0));
    setContentView(applySystemInsets(content));
  }

  private String locationTitle() {
    if (!LOCATION_TRASH.equals(location) && !searchQuery.trim().isEmpty()) return "搜索全部笔记";
    if (LOCATION_ALL.equals(location)) return "全部笔记";
    if (LOCATION_UNFILED.equals(location)) return "全部笔记";
    if (LOCATION_TRASH.equals(location)) return "回收站";
    String id = location.substring(LOCATION_FOLDER_PREFIX.length());
    for (Models.FolderDocument folder : folders) {
      if (folder.envelope.id.equals(id)) return folder.name;
    }
    return "文件夹";
  }

  private String folderName(String id) {
    if (id == null) return "无文件夹";
    for (Models.FolderDocument folder : folders) {
      if (folder.envelope.id.equals(id)) return folder.name;
    }
    return "未分类";
  }

  private String modeTitle() {
    return displayMode == 0 ? "列表" : displayMode == 1 ? "卡片" : "标题";
  }

  private String saveStatusText() {
    if (saving) return "正在保存…";
    if (dirty) return "有未保存更改";
    return selectedNote != null && selectedNote.envelope.locked ? "正文受保护" : "内容已解密";
  }

  private void setSavingMessage(String value) {
    if (saveStatus != null) {
      saveStatus.setText(value);
      saveStatus.setTextColor(getColor(R.color.text_secondary));
    }
  }

  private static void applyMutation(Models.NoteEnvelope envelope, JSONObject json) {
    envelope.folderId = Models.nullableString(json, "folderId");
    envelope.revision = json.optInt("revision", envelope.revision);
    envelope.updatedAt = Models.nullableString(json, "updatedAt");
    envelope.deletedAt = Models.nullableString(json, "deletedAt");
    envelope.locked = json.optBoolean("isLocked", envelope.locked);
  }

  private static void copyEnvelope(Models.NoteEnvelope target, Models.NoteEnvelope source) {
    target.folderId = source.folderId;
    target.revision = source.revision;
    target.ciphertext = source.ciphertext;
    target.nonce = source.nonce;
    target.updatedAt = source.updatedAt;
    target.deletedAt = source.deletedAt;
    target.locked = source.locked;
  }

  private <T> void runAsync(Callable<T> work, Consumer<T> success) {
    runAsync(work, success, this::showError);
  }

  private <T> void runAsync(Callable<T> work, Consumer<T> success, Consumer<Exception> failure) {
    executor.submit(() -> {
      try {
        T result = work.call();
        runOnUiThread(() -> success.accept(result));
      } catch (Exception error) {
        runOnUiThread(() -> failure.accept(error));
      }
    });
  }

  private void showError(Exception error) {
    String message = error.getMessage();
    if (message == null || message.trim().isEmpty()) message = "操作失败，请稍后重试。";
    toast(message);
    if (!editorVisible && user == null) {
      showLogin();
    } else if (!editorVisible) {
      String finalMessage = message;
      new AlertDialog.Builder(this)
        .setTitle("无法加载笔记")
        .setMessage(finalMessage)
        .setPositiveButton("重新加载", (dialog, which) -> loadAllData())
        .setNegativeButton("取消", null)
        .show();
    }
  }

  private void toast(String message) {
    Toast.makeText(this, message, Toast.LENGTH_LONG).show();
  }

  private void keyboard(View view, boolean show) {
    if (view == null) return;
    InputMethodManager input = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
    if (show) input.showSoftInput(view, InputMethodManager.SHOW_IMPLICIT);
    else input.hideSoftInputFromWindow(view.getWindowToken(), 0);
  }

  private <T extends View> T applySystemInsets(T view) {
    int left = view.getPaddingLeft();
    int top = view.getPaddingTop();
    int right = view.getPaddingRight();
    int bottom = view.getPaddingBottom();
    view.setOnApplyWindowInsetsListener((target, insets) -> {
      Insets bars = insets.getInsets(
        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
      );
      target.setPadding(
        left + bars.left,
        top + bars.top,
        right + bars.right,
        bottom + bars.bottom
      );
      return insets;
    });
    view.requestApplyInsets();
    return view;
  }

  private LinearLayout verticalLayout(int spacing) {
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    if (spacing > 0) layout.setDividerPadding(dp(spacing));
    return layout;
  }

  private LinearLayout horizontalLayout(int gravity) {
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

  private EditText editText(String hint, boolean password) {
    EditText field = new EditText(this);
    field.setHint(hint);
    field.setTextColor(getColor(R.color.text_primary));
    field.setHintTextColor(getColor(R.color.text_secondary));
    field.setTextSize(16);
    field.setPadding(dp(16), dp(8), dp(16), dp(8));
    StateListDrawable background = new StateListDrawable();
    background.addState(
      new int[] { android.R.attr.state_focused },
      roundedStrokeBackground(R.color.surface, R.color.brand_primary, 16, 2)
    );
    background.addState(
      new int[] {},
      roundedStrokeBackground(R.color.surface, R.color.divider, 16, 1)
    );
    field.setBackground(background);
    if (password) {
      field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
    }
    return field;
  }

  private Drawable roundedBackground(int colorRes, int radiusDp) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setColor(getColor(colorRes));
    drawable.setCornerRadius(dp(radiusDp));
    return drawable;
  }

  private Drawable roundedStrokeBackground(
    int colorRes,
    int strokeColorRes,
    int radiusDp,
    int strokeDp
  ) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setColor(getColor(colorRes));
    drawable.setCornerRadius(dp(radiusDp));
    drawable.setStroke(dp(strokeDp), getColor(strokeColorRes));
    return drawable;
  }

  private Drawable rippleBackground(int colorRes, int radiusDp) {
    GradientDrawable content = new GradientDrawable();
    content.setColor(getColor(colorRes));
    content.setCornerRadius(dp(radiusDp));
    GradientDrawable mask = new GradientDrawable();
    mask.setColor(Color.WHITE);
    mask.setCornerRadius(dp(radiusDp));
    return new RippleDrawable(
      ColorStateList.valueOf(getColor(R.color.surface_high)),
      content,
      mask
    );
  }

  private Drawable rippleStrokeBackground(int colorRes, int strokeColorRes, int radiusDp) {
    GradientDrawable content = new GradientDrawable();
    content.setColor(getColor(colorRes));
    content.setCornerRadius(dp(radiusDp));
    content.setStroke(dp(1), getColor(strokeColorRes));
    GradientDrawable mask = new GradientDrawable();
    mask.setColor(Color.WHITE);
    mask.setCornerRadius(dp(radiusDp));
    return new RippleDrawable(
      ColorStateList.valueOf(getColor(R.color.surface_high)),
      content,
      mask
    );
  }

  private ImageView iconView(int drawableRes, int tintRes, String description, int iconDp) {
    ImageView icon = new ImageView(this);
    icon.setImageResource(drawableRes);
    icon.setImageTintList(ColorStateList.valueOf(getColor(tintRes)));
    icon.setContentDescription(description);
    icon.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
    icon.setMinimumWidth(dp(iconDp));
    icon.setMinimumHeight(dp(iconDp));
    return icon;
  }

  private ImageButton iconButton(int drawableRes, String description, boolean tonal) {
    ImageButton button = new ImageButton(this);
    button.setImageResource(drawableRes);
    button.setImageTintList(ColorStateList.valueOf(getColor(R.color.brand_primary_dark)));
    button.setContentDescription(description);
    button.setPadding(dp(12), dp(12), dp(12), dp(12));
    button.setBackground(rippleBackground(tonal ? R.color.surface_tonal : R.color.background, 16));
    button.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
    button.setMinimumWidth(dp(48));
    button.setMinimumHeight(dp(48));
    return button;
  }

  private IconTextButton primaryIconButton(String label, int drawableRes) {
    return new IconTextButton(label, drawableRes);
  }

  private Button secondaryButton(String label) {
    Button button = new Button(this);
    button.setText(label);
    button.setTextSize(15);
    button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    button.setTextColor(getColor(R.color.brand_primary_dark));
    button.setAllCaps(false);
    button.setGravity(Gravity.CENTER);
    button.setMinHeight(dp(48));
    button.setBackground(rippleStrokeBackground(R.color.surface, R.color.brand_primary, 18));
    return button;
  }

  private Button chipButton(String label, int drawableRes, boolean selected) {
    Button button = new Button(this);
    button.setText(label);
    button.setTextSize(13);
    button.setAllCaps(false);
    button.setGravity(Gravity.CENTER);
    button.setMinHeight(dp(40));
    button.setMinWidth(dp(48));
    button.setPadding(dp(14), 0, dp(14), 0);
    button.setTextColor(getColor(selected ? R.color.on_brand : R.color.text_primary));
    Drawable icon = getDrawable(drawableRes);
    icon.setTint(getColor(selected ? R.color.on_brand : R.color.text_secondary));
    icon.setBounds(0, 0, dp(18), dp(18));
    button.setCompoundDrawablePadding(dp(7));
    button.setCompoundDrawables(icon, null, null, null);
    button.setBackground(rippleBackground(selected ? R.color.brand_primary : R.color.surface, 14));
    button.setContentDescription(label + (selected ? "，已选择" : ""));
    button.setSelected(selected);
    return button;
  }

  private int modeIcon() {
    return displayMode == 0 ? R.drawable.ic_list : displayMode == 1 ? R.drawable.ic_grid : R.drawable.ic_title;
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private LinearLayout.LayoutParams matchWrap(int left, int top, int right, int bottom) {
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    );
    params.setMargins(dp(left), dp(top), dp(right), dp(bottom));
    return params;
  }

  private LinearLayout.LayoutParams matchHeight(int height, int left, int top, int right, int bottom) {
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      height
    );
    params.setMargins(dp(left), dp(top), dp(right), dp(bottom));
    return params;
  }

  private FrameLayout.LayoutParams frameMatch() {
    return new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    );
  }

  private FrameLayout.LayoutParams frameHeight(int height) {
    return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height);
  }

  private static abstract class SimpleTextWatcher implements TextWatcher {
    @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
    @Override public void onTextChanged(CharSequence value, int start, int before, int count) {}
  }

  private final class IconTextButton extends LinearLayout {
    private final TextView labelView;

    IconTextButton(String label, int drawableRes) {
      super(MainActivity.this);
      setOrientation(HORIZONTAL);
      setGravity(Gravity.CENTER);
      setPadding(dp(18), 0, dp(18), 0);
      setMinimumHeight(dp(48));
      setClickable(true);
      setFocusable(true);
      setContentDescription(label);
      setBackground(rippleBackground(R.color.brand_primary, 18));

      ImageView icon = iconView(drawableRes, R.color.on_brand, null, 22);
      addView(icon, new LinearLayout.LayoutParams(dp(22), dp(22)));
      labelView = text(label, 16, R.color.on_brand);
      labelView.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
      LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      );
      labelParams.setMarginStart(dp(10));
      addView(labelView, labelParams);
    }

    void setText(String value) {
      labelView.setText(value);
      setContentDescription(value);
    }

    @Override
    public void setEnabled(boolean enabled) {
      super.setEnabled(enabled);
      setAlpha(enabled ? 1f : 0.5f);
    }

    @Override
    public CharSequence getAccessibilityClassName() {
      return Button.class.getName();
    }
  }

  private final class NotesAdapter extends BaseAdapter {
    @Override public int getCount() { return visibleNotes.size(); }
    @Override public Models.NoteDocument getItem(int position) { return visibleNotes.get(position); }
    @Override public long getItemId(int position) { return position; }

    @Override
    public View getView(int position, View recycled, ViewGroup parent) {
      Models.NoteDocument note = getItem(position);
      FrameLayout outer = new FrameLayout(MainActivity.this);
      outer.setPadding(dp(4), dp(4), dp(4), dp(4));
      LinearLayout cell = verticalLayout(0);
      cell.setPadding(dp(16), dp(15), dp(16), dp(14));
      cell.setBackground(rippleStrokeBackground(
        displayMode == 1 ? R.color.surface_variant : R.color.surface,
        R.color.divider,
        18
      ));
      cell.setMinimumHeight(dp(displayMode == 1 ? 176 : displayMode == 2 ? 72 : 116));

      LinearLayout titleRow = horizontalLayout(Gravity.CENTER_VERTICAL);
      if (note.envelope.locked) {
        ImageView lock = iconView(R.drawable.ic_lock, R.color.brand_primary_dark, "受保护笔记", 16);
        titleRow.addView(lock, new LinearLayout.LayoutParams(dp(26), dp(26)));
      }
      TextView title = text(note.title(), displayMode == 1 ? 18 : 17, R.color.text_primary);
      title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
      title.setMaxLines(displayMode == 1 ? 2 : 1);
      title.setEllipsize(android.text.TextUtils.TruncateAt.END);
      LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
      if (note.envelope.locked) titleParams.setMarginStart(dp(6));
      titleRow.addView(title, titleParams);
      cell.addView(titleRow, matchWrap(0, 0, 0, 7));

      if (displayMode != 2) {
        TextView excerpt = text(note.excerpt(), 14, R.color.text_secondary);
        excerpt.setLineSpacing(dp(2), 1.12f);
        excerpt.setMaxLines(displayMode == 1 ? 4 : 2);
        excerpt.setEllipsize(android.text.TextUtils.TruncateAt.END);
        cell.addView(excerpt, new LinearLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          displayMode == 1 ? 0 : ViewGroup.LayoutParams.WRAP_CONTENT,
          displayMode == 1 ? 1 : 0
        ));
      }
      LinearLayout metadata = horizontalLayout(Gravity.CENTER_VERTICAL);
      ImageView folderIcon = iconView(R.drawable.ic_folder, R.color.text_secondary, "所在文件夹", 14);
      metadata.addView(folderIcon, new LinearLayout.LayoutParams(dp(22), dp(22)));
      TextView folder = text(folderName(note.envelope.folderId), 12, R.color.text_secondary);
      folder.setMaxLines(1);
      folder.setEllipsize(android.text.TextUtils.TruncateAt.END);
      metadata.addView(folder, new LinearLayout.LayoutParams(0, dp(28), 1));
      TextView date = text(note.envelope.displayDate(), 12, R.color.text_secondary);
      date.setGravity(Gravity.CENTER_VERTICAL | Gravity.END);
      metadata.addView(date, new LinearLayout.LayoutParams(dp(64), dp(28)));
      cell.addView(metadata, matchWrap(0, displayMode == 2 ? 2 : 10, 0, 0));
      outer.addView(cell, frameMatch());
      return outer;
    }
  }

  private static final class LoadedData {
    final SecretKey dataKey;
    final Models.ProtectionKeyring keyring;
    final List<Models.FolderDocument> folders;
    final List<Models.NoteDocument> notes;
    final List<Models.NoteDocument> trash;

    LoadedData(
      SecretKey dataKey,
      Models.ProtectionKeyring keyring,
      List<Models.FolderDocument> folders,
      List<Models.NoteDocument> notes,
      List<Models.NoteDocument> trash
    ) {
      this.dataKey = dataKey;
      this.keyring = keyring;
      this.folders = folders;
      this.notes = notes;
      this.trash = trash;
    }
  }

  private static final class SavedNote {
    final Models.NoteEnvelope envelope;
    final Models.ProtectedBody protectedContent;

    SavedNote(Models.NoteEnvelope envelope, Models.ProtectedBody protectedContent) {
      this.envelope = envelope;
      this.protectedContent = protectedContent;
    }
  }

  private static final class StoredProtection {
    final Models.ProtectionKeyring keyring;
    final SecretKey key;

    StoredProtection(Models.ProtectionKeyring keyring, SecretKey key) {
      this.keyring = keyring;
      this.key = key;
    }
  }

  private static final class ProtectionCredentials {
    final String password;
    ProtectionCredentials(String password) { this.password = password; }
  }

  private static final class SelectedMedia {
    final byte[] bytes;
    final String contentType;
    final int width;
    final int height;
    final int durationMillis;

    SelectedMedia(byte[] bytes, String contentType, int width, int height, int durationMillis) {
      this.bytes = bytes;
      this.contentType = contentType;
      this.width = width;
      this.height = height;
      this.durationMillis = durationMillis;
    }
  }
}
