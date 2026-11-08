import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import type { Language, SessionPhase } from '../types';

const zhCN = {
  navSection: '创作空间', workspace: '工作台', models: '模型服务', preferences: '偏好设置',
  workspaceEyebrow: 'YOUR VOICE, IN FLOW', workspaceTitle: '让想法，自然成文', workspaceDescription: '说出你的想法，剩下的交给 FlowVoice。',
  modelsEyebrow: 'MAKE IT YOURS', modelsTitle: '选择你的模型', modelsDescription: '识别与写作独立配置，本地、云端，自由组合。',
  settingsEyebrow: 'A LITTLE MORE YOU', settingsTitle: '按你的习惯来', settingsDescription: '设置语言与快捷键，让语音输入融入日常。',
  dictate: '实时输入', dictateHint: '边说边写进同一词条', polish: '润色改写', polishHint: '整理口述，表达更清晰', compose: '帮我写', composeHint: '说出要求，生成内容',
  idle: '准备好，开始说话', recording: '正在聆听你的声音', transcribing: '正在识别语音', generating: '正在整理文字', done: '文字已准备好', error: '这次处理未完成', cancelled: '录音已取消',
  inputModes: '输入模式', microphoneActive: '麦克风正在使用', voiceWorkspace: '语音工作台',
  stopRecording: '结束录音', startRecording: '开始录音', releaseToStop: '松开快捷键或点击按钮，结束录音',
  prepareModel: '先在模型服务中准备语音识别模型', composePrompt: '告诉我想写什么，以及语气、长度和用途', startPrompt: '点击麦克风，或按住全局快捷键说话',
  cancelTask: '取消本次任务', holdToTalk: '按住说话，松开结束', local: '本地', cloud: '云端', speechRecognition: '语音识别',
  audioStaysLocal: '音频留在你的电脑', audioSentToProvider: '音频发送至已配置的服务', modelSettings: '模型设置',
  languageModel: '语言模型', localWritingService: '本地写作服务', cloudWritingService: '云端写作服务，转写文字将发送至该服务',
  llmRequired: '此模式需要语言模型。', configure: '前往配置', orDictate: '，或选择实时输入。',
  textResult: '文字结果', manualInput: '＋ 手动输入', dictationStats: '听写统计', totalDuration: '总听写时长', inputAmount: '输入量', averageSpeed: '平均速度',
  emptyEntries: '每次听写都会形成一条独立记录，出现在这里。', audioNotStored: '默认不保存原始音频；记录仅保留在本次会话。',
  dictationFor: '听写', recognizing: '正在识别', copied: '已复制', copy: '复制', polishAction: '润色', composeAction: '写作', deleteEntry: '删除这条记录',
  liveTranscript: '实时识别文字', listeningNext: '正在聆听下一句…', editableTranscript: '听写文字，可编辑', transcriptPlaceholder: '输入或粘贴文字，可交给 AI 润色或续写。', viewRawTranscript: '查看原始转写',
  quickStartTitle: '在常用输入框，随时开口', quickStartDescription: '将光标放入微信、文档或浏览器输入框，再按快捷键。实时输入按语句追加，AI 结果先预览。', inputPreferences: '查看输入偏好',
  asrTitle: '语音识别', asrDescription: '把你的声音转成文字', localModel: '本地模型', cloudService: '云端服务',
  localModelDescription: '中文优先 · 本地推理 · 模型约 240 MB', ready: '已就绪', notReady: '待准备',
  modelDirectory: '模型目录', modelDirectoryHint: '选择包含 model.int8.onnx 与 tokens.txt 的目录。', modelDirectoryPlaceholder: '下载模型，或选择已有模型目录', chooseModelDirectory: '选择 SenseVoice 模型目录', chooseModelDirectoryShort: '选择模型目录',
  downloadModel: '下载 SenseVoice 模型', downloadingModel: '正在下载模型…', downloadOnlyOnline: '仅下载时需要联网',
  cloudAsrNotice: '录音将发送到下面配置的服务。需支持 OpenAI 兼容的音频转写接口。', baseUrlHint: '例如 https://api.example.com/v1；不要填写完整的 /audio/transcriptions 地址。', modelId: '模型 ID', modelIdPlaceholder: '例如 whisper-1',
  pendingProviderSave: '服务变更待保存', configured: '已配置', apiKeyHint: '留空保留已有密钥；密钥由桌面端安全存储。', replaceApiKey: '输入新密钥以替换', enterApiKey: '输入服务的 API Key',
  llmTitle: '语言模型', llmDescription: '润色表达，或按你的要求写作', disabled: '暂不使用', localService: '本地服务',
  llmDisabledTitle: '先让声音变成文字', llmDisabledDescription: '实时输入无需语言模型。准备好后，再开启润色与写作。',
  localLlmNotice: '连接已启动的本机 OpenAI 兼容服务，例如 llama.cpp 或 Ollama。此版本不代为启动模型服务。', cloudLlmNotice: '转写或你提交的文字将发送到所选服务。需支持 OpenAI 兼容的 Chat Completions 接口。',
  localUrlHint: '本地模式仅允许 localhost、127.0.0.1 或 [::1] 回环地址。', cloudUrlHint: '填写服务的 API 前缀，一般以 /v1 结尾。',
  localModelIdPlaceholder: '填写本地服务加载的模型名称', cloudModelIdPlaceholder: '填写服务商提供的模型 ID',
  llmApiKeyHint: '留空保留已有密钥；未启用鉴权的本地服务可不填写。', apiKeyPlaceholder: '输入 API Key（按服务要求）',
  saveWhenIdle: '当前任务结束后可保存设置', modelSettingsSaved: '模型设置已保存', settingsApplyNotice: '设置在保存后生效；不会自动切换到云端', saved: '已保存', saveModelSettings: '保存模型设置',
  appearanceLanguage: '外观与语言', appearanceLanguageDescription: '选择你熟悉的界面语言', interfaceLanguage: '界面语言', languageHint: '切换后立即生效，随偏好设置保存；不会改变语音识别或 AI 输出语言。',
  simplifiedChinese: '简体中文', traditionalChinese: '繁體中文', english: 'English',
  recordingInput: '录音与输入', recordingInputDescription: '在不同应用之间保持顺畅', globalShortcut: '全局录音快捷键',
  shortcutHintMac: '点击右侧按钮后直接按下组合键（需至少含一个 ⌘、⌥、⇧ 或 Ctrl 修饰键）；按住开始录音，松开结束。',
  shortcutHintWindows: '点击右侧按钮后直接按下组合键（需至少含一个 Ctrl、Alt、Shift 或 Win 修饰键）；按住开始录音，松开结束。',
  autoInsert: '实时输入自动回填', autoInsertDescription: '本地识别按语句追加到原输入框；AI 生成结果先预览。',
  inputSafetyNotice: '目标窗口变化或无法安全输入时保留结果供复制。默认不保存原始录音，本地识别失败不会自动上传云端。',
  systemPermissions: '系统权限', accessibilityDescription: 'macOS 跨应用输入需要辅助功能权限', granted: '已授权', notGranted: '待授权',
  permissionsDescription: '首次录音时系统会请求麦克风权限。启用辅助功能后，FlowVoice 才能向其他应用输入文字。', requestPermission: '检查并请求权限',
  preferencesSaved: '偏好设置已保存', shortcutConflictHint: '快捷键如被占用，保存时会提示', saving: '保存中…', savePreferences: '保存偏好设置',
  cancelRecording: '取消录音', listening: '正在聆听',
  modelChoiceTitle: '模型由你选择', modelChoiceLocal: '本地保护隐私', modelChoiceCloud: '云端拓展能力', manageModels: '管理模型', settingsHelp: '查看偏好设置与使用帮助',
  previewNotice: '浏览器预览 · 录音、模型下载和设置保存需在桌面应用中使用。', dismissError: '关闭错误提示', footer: '少一点敲击，多一点心流。', headingPunctuation: '。',
  desktopOnly: '请在 FlowVoice 桌面应用中使用此功能。浏览器仅用于界面预览。', backendConnectionFailed: '连接桌面服务失败',
  recordingShortcut: '正在录制全局快捷键，按 Esc 取消', shortcutButton: '全局录音快捷键', pressShortcut: '请按下组合键，Esc 取消',
  space: '空格', chars: '字', charsPerMinute: '字/分', hours: '小时', minutes: '分', seconds: '秒',
};

export type TranslationKey = keyof typeof zhCN;
export type Translations = Record<TranslationKey, string>;

const zhTW: Translations = {
  ...zhCN,
  navSection: '創作空間', workspace: '工作台', models: '模型服務', preferences: '偏好設定',
  workspaceTitle: '讓想法，自然成文', workspaceDescription: '說出你的想法，剩下的交給 FlowVoice。',
  modelsTitle: '選擇你的模型', modelsDescription: '識別與寫作獨立設定，本地、雲端，自由組合。',
  settingsTitle: '按你的習慣來', settingsDescription: '設定語言與快捷鍵，讓語音輸入融入日常。',
  dictate: '即時輸入', dictateHint: '邊說邊寫進同一詞條', polish: '潤色改寫', polishHint: '整理口述，表達更清晰', compose: '幫我寫', composeHint: '說出要求，產生內容',
  idle: '準備好，開始說話', recording: '正在聆聽你的聲音', transcribing: '正在識別語音', generating: '正在整理文字', done: '文字已準備好', error: '這次處理未完成', cancelled: '錄音已取消',
  inputModes: '輸入模式', microphoneActive: '麥克風正在使用', voiceWorkspace: '語音工作台',
  stopRecording: '結束錄音', startRecording: '開始錄音', releaseToStop: '放開快捷鍵或點擊按鈕，結束錄音',
  prepareModel: '先在模型服務中準備語音識別模型', composePrompt: '告訴我想寫什麼，以及語氣、長度和用途', startPrompt: '點擊麥克風，或按住全域快捷鍵說話',
  cancelTask: '取消本次任務', holdToTalk: '按住說話，放開結束', local: '本地', cloud: '雲端', speechRecognition: '語音識別',
  audioStaysLocal: '音訊留在你的電腦', audioSentToProvider: '音訊傳送至已設定的服務', modelSettings: '模型設定',
  languageModel: '語言模型', localWritingService: '本地寫作服務', cloudWritingService: '雲端寫作服務，轉寫文字將傳送至該服務',
  llmRequired: '此模式需要語言模型。', configure: '前往設定', orDictate: '，或選擇即時輸入。',
  textResult: '文字結果', manualInput: '＋ 手動輸入', dictationStats: '聽寫統計', totalDuration: '總聽寫時長', inputAmount: '輸入量', averageSpeed: '平均速度',
  emptyEntries: '每次聽寫都會形成一條獨立記錄，顯示在這裡。', audioNotStored: '預設不儲存原始音訊；記錄僅保留在本次工作階段。',
  dictationFor: '聽寫', recognizing: '正在識別', copied: '已複製', copy: '複製', polishAction: '潤色', composeAction: '寫作', deleteEntry: '刪除這條記錄',
  liveTranscript: '即時識別文字', listeningNext: '正在聆聽下一句…', editableTranscript: '聽寫文字，可編輯', transcriptPlaceholder: '輸入或貼上文字，可交給 AI 潤色或續寫。', viewRawTranscript: '檢視原始轉寫',
  quickStartTitle: '在常用輸入框，隨時開口', quickStartDescription: '將游標放入微信、文件或瀏覽器輸入框，再按快捷鍵。即時輸入按語句追加，AI 結果先預覽。', inputPreferences: '檢視輸入偏好',
  asrTitle: '語音識別', asrDescription: '把你的聲音轉成文字', localModel: '本地模型', cloudService: '雲端服務',
  localModelDescription: '中文優先 · 本地推論 · 模型約 240 MB', ready: '已就緒', notReady: '待準備',
  modelDirectory: '模型目錄', modelDirectoryHint: '選擇包含 model.int8.onnx 與 tokens.txt 的目錄。', modelDirectoryPlaceholder: '下載模型，或選擇已有模型目錄', chooseModelDirectory: '選擇 SenseVoice 模型目錄', chooseModelDirectoryShort: '選擇模型目錄',
  downloadModel: '下載 SenseVoice 模型', downloadingModel: '正在下載模型…', downloadOnlyOnline: '僅下載時需要連網',
  cloudAsrNotice: '錄音將傳送到下面設定的服務。需支援 OpenAI 相容的音訊轉寫介面。', baseUrlHint: '例如 https://api.example.com/v1；不要填寫完整的 /audio/transcriptions 位址。', modelId: '模型 ID', modelIdPlaceholder: '例如 whisper-1',
  pendingProviderSave: '服務變更待儲存', configured: '已設定', apiKeyHint: '留空保留已有金鑰；金鑰由桌面端安全儲存。', replaceApiKey: '輸入新金鑰以取代', enterApiKey: '輸入服務的 API Key',
  llmTitle: '語言模型', llmDescription: '潤色表達，或按你的要求寫作', disabled: '暫不使用', localService: '本地服務',
  llmDisabledTitle: '先讓聲音變成文字', llmDisabledDescription: '即時輸入無需語言模型。準備好後，再開啟潤色與寫作。',
  localLlmNotice: '連接已啟動的本機 OpenAI 相容服務，例如 llama.cpp 或 Ollama。此版本不代為啟動模型服務。', cloudLlmNotice: '轉寫或你提交的文字將傳送到所選服務。需支援 OpenAI 相容的 Chat Completions 介面。',
  localUrlHint: '本地模式僅允許 localhost、127.0.0.1 或 [::1] 回環位址。', cloudUrlHint: '填寫服務的 API 前綴，一般以 /v1 結尾。',
  localModelIdPlaceholder: '填寫本地服務載入的模型名稱', cloudModelIdPlaceholder: '填寫服務商提供的模型 ID',
  llmApiKeyHint: '留空保留已有金鑰；未啟用驗證的本地服務可不填寫。', apiKeyPlaceholder: '輸入 API Key（按服務要求）',
  saveWhenIdle: '本次任務結束後可儲存設定', modelSettingsSaved: '模型設定已儲存', settingsApplyNotice: '設定在儲存後生效；不會自動切換到雲端', saved: '已儲存', saveModelSettings: '儲存模型設定',
  appearanceLanguage: '外觀與語言', appearanceLanguageDescription: '選擇你熟悉的介面語言', interfaceLanguage: '介面語言', languageHint: '切換後立即生效，隨偏好設定儲存；不會改變語音識別或 AI 輸出語言。',
  simplifiedChinese: '简体中文', traditionalChinese: '繁體中文', english: 'English',
  recordingInput: '錄音與輸入', recordingInputDescription: '在不同應用之間保持順暢', globalShortcut: '全域錄音快捷鍵',
  shortcutHintMac: '點擊右側按鈕後直接按下組合鍵（需至少含一個 ⌘、⌥、⇧ 或 Ctrl 修飾鍵）；按住開始錄音，放開結束。',
  shortcutHintWindows: '點擊右側按鈕後直接按下組合鍵（需至少含一個 Ctrl、Alt、Shift 或 Win 修飾鍵）；按住開始錄音，放開結束。',
  autoInsert: '即時輸入自動回填', autoInsertDescription: '本地識別按語句追加到原輸入框；AI 產生結果先預覽。',
  inputSafetyNotice: '目標視窗變化或無法安全輸入時保留結果供複製。預設不儲存原始錄音，本地識別失敗不會自動上傳雲端。',
  systemPermissions: '系統權限', accessibilityDescription: 'macOS 跨應用輸入需要輔助使用權限', granted: '已授權', notGranted: '待授權',
  permissionsDescription: '首次錄音時系統會請求麥克風權限。啟用輔助使用後，FlowVoice 才能向其他應用輸入文字。', requestPermission: '檢查並請求權限',
  preferencesSaved: '偏好設定已儲存', shortcutConflictHint: '快捷鍵如被占用，儲存時會提示', saving: '儲存中…', savePreferences: '儲存偏好設定',
  cancelRecording: '取消錄音', listening: '正在聆聽',
  modelChoiceTitle: '模型由你選擇', modelChoiceLocal: '本地保護隱私', modelChoiceCloud: '雲端拓展能力', manageModels: '管理模型', settingsHelp: '檢視偏好設定與使用說明',
  previewNotice: '瀏覽器預覽 · 錄音、模型下載和設定儲存需在桌面應用中使用。', dismissError: '關閉錯誤提示', footer: '少一點敲擊，多一點心流。', headingPunctuation: '。',
  desktopOnly: '請在 FlowVoice 桌面應用中使用此功能。瀏覽器僅用於介面預覽。', backendConnectionFailed: '連接桌面服務失敗',
  recordingShortcut: '正在錄製全域快捷鍵，按 Esc 取消', shortcutButton: '全域錄音快捷鍵', pressShortcut: '請按下組合鍵，Esc 取消',
  space: '空格', chars: '字', charsPerMinute: '字/分', hours: '小時', minutes: '分', seconds: '秒',
};

const en: Translations = {
  navSection: 'CREATE', workspace: 'Workspace', models: 'Models', preferences: 'Preferences',
  workspaceEyebrow: 'YOUR VOICE, IN FLOW', workspaceTitle: 'Ideas, naturally written', workspaceDescription: 'Speak your mind. Let FlowVoice handle the rest.',
  modelsEyebrow: 'MAKE IT YOURS', modelsTitle: 'Choose your models', modelsDescription: 'Configure speech and writing independently, locally or in the cloud.',
  settingsEyebrow: 'A LITTLE MORE YOU', settingsTitle: 'Make it yours', settingsDescription: 'Choose your language and shortcuts to fit voice input into your day.',
  dictate: 'Live dictation', dictateHint: 'Keep every sentence in one entry', polish: 'Polish', polishHint: 'Make your spoken ideas clearer', compose: 'Write for me', composeHint: 'Describe what you want to create',
  idle: 'Ready when you are', recording: 'Listening to your voice', transcribing: 'Transcribing your speech', generating: 'Polishing your text', done: 'Your text is ready', error: 'Could not complete this task', cancelled: 'Recording cancelled',
  inputModes: 'Input modes', microphoneActive: 'Microphone in use', voiceWorkspace: 'Voice workspace',
  stopRecording: 'Stop recording', startRecording: 'Start recording', releaseToStop: 'Release the shortcut or click the button to stop',
  prepareModel: 'Set up a speech recognition model in Models first', composePrompt: 'Describe the content, tone, length and purpose', startPrompt: 'Click the microphone or hold the global shortcut to speak',
  cancelTask: 'Cancel this task', holdToTalk: 'Hold to talk, release to finish', local: 'Local', cloud: 'Cloud', speechRecognition: 'Speech recognition',
  audioStaysLocal: 'Audio stays on your computer', audioSentToProvider: 'Audio is sent to your configured provider', modelSettings: 'Model settings',
  languageModel: 'language model', localWritingService: 'local writing service', cloudWritingService: 'cloud writing service; your transcript will be sent to this provider',
  llmRequired: 'This mode needs a language model.', configure: 'Configure one', orDictate: ', or choose Live dictation.',
  textResult: 'Text results', manualInput: '＋ Add text', dictationStats: 'Dictation statistics', totalDuration: 'Total dictation time', inputAmount: 'Characters', averageSpeed: 'Average speed',
  emptyEntries: 'Each dictation creates a separate entry here.', audioNotStored: 'Raw audio is not saved by default. Entries only remain for this session.',
  dictationFor: 'Dictated', recognizing: 'Recognizing', copied: 'Copied', copy: 'Copy', polishAction: 'Polish', composeAction: 'Write', deleteEntry: 'Delete this entry',
  liveTranscript: 'Live transcript', listeningNext: 'Listening for the next sentence…', editableTranscript: 'Dictated text, editable', transcriptPlaceholder: 'Type or paste text for AI to polish or continue.', viewRawTranscript: 'View raw transcript',
  quickStartTitle: 'Speak wherever you type', quickStartDescription: 'Place the cursor in a chat, document or browser field and press the shortcut. Live dictation appends by sentence; AI results appear for review.', inputPreferences: 'View input preferences',
  asrTitle: 'Speech recognition', asrDescription: 'Turn your voice into text', localModel: 'Local model', cloudService: 'Cloud service',
  localModelDescription: 'Chinese-first · On-device inference · About 240 MB', ready: 'Ready', notReady: 'Setup needed',
  modelDirectory: 'Model directory', modelDirectoryHint: 'Choose a directory containing model.int8.onnx and tokens.txt.', modelDirectoryPlaceholder: 'Download a model or choose an existing directory', chooseModelDirectory: 'Choose SenseVoice model directory', chooseModelDirectoryShort: 'Choose model directory',
  downloadModel: 'Download SenseVoice model', downloadingModel: 'Downloading model…', downloadOnlyOnline: 'Internet is only needed for downloading',
  cloudAsrNotice: 'Audio will be sent to the provider configured below. It must support an OpenAI-compatible audio transcription endpoint.', baseUrlHint: 'For example https://api.example.com/v1; do not include the full /audio/transcriptions path.', modelId: 'Model ID', modelIdPlaceholder: 'For example whisper-1',
  pendingProviderSave: 'Provider change not saved', configured: 'Configured', apiKeyHint: 'Leave blank to keep the current key. Keys are stored securely by the desktop app.', replaceApiKey: 'Enter a new key to replace it', enterApiKey: 'Enter the provider API key',
  llmTitle: 'Language model', llmDescription: 'Polish your writing or create content from your instructions', disabled: 'Not in use', localService: 'Local service',
  llmDisabledTitle: 'Start by turning speech into text', llmDisabledDescription: 'Live dictation works without a language model. Enable one when you are ready to polish or write.',
  localLlmNotice: 'Connect to a running on-device OpenAI-compatible service such as llama.cpp or Ollama. FlowVoice does not start a model service for you.', cloudLlmNotice: 'Your transcript or submitted text will be sent to the selected provider. It must support OpenAI-compatible Chat Completions.',
  localUrlHint: 'Local mode only allows localhost, 127.0.0.1 or [::1] loopback addresses.', cloudUrlHint: 'Enter the provider API prefix, usually ending in /v1.',
  localModelIdPlaceholder: 'Enter the model name loaded by your local service', cloudModelIdPlaceholder: 'Enter the model ID supplied by your provider',
  llmApiKeyHint: 'Leave blank to keep the current key. Local services without authentication do not need one.', apiKeyPlaceholder: 'Enter an API key if your provider requires one',
  saveWhenIdle: 'Settings can be saved after the current task finishes', modelSettingsSaved: 'Model settings saved', settingsApplyNotice: 'Changes apply after saving. FlowVoice will not switch to the cloud automatically', saved: 'Saved', saveModelSettings: 'Save model settings',
  appearanceLanguage: 'Appearance & language', appearanceLanguageDescription: 'Choose the interface language you prefer', interfaceLanguage: 'Interface language', languageHint: 'Changes apply immediately and are saved with your preferences. This does not change speech recognition or AI output languages.',
  simplifiedChinese: '简体中文', traditionalChinese: '繁體中文', english: 'English',
  recordingInput: 'Recording & input', recordingInputDescription: 'Keep your flow across applications', globalShortcut: 'Global recording shortcut',
  shortcutHintMac: 'Click the button and press a combination with at least one ⌘, ⌥, ⇧ or Ctrl modifier. Hold to record and release to finish.',
  shortcutHintWindows: 'Click the button and press a combination with at least one Ctrl, Alt, Shift or Win modifier. Hold to record and release to finish.',
  autoInsert: 'Insert live dictation automatically', autoInsertDescription: 'Local recognition appends sentences to the original field. AI-generated results appear for review first.',
  inputSafetyNotice: 'If the target window changes or text cannot be inserted safely, the result remains available to copy. Raw audio is not saved by default, and failed local recognition never switches to the cloud automatically.',
  systemPermissions: 'System permissions', accessibilityDescription: 'macOS needs Accessibility permission for cross-app input', granted: 'Granted', notGranted: 'Required',
  permissionsDescription: 'macOS will request microphone access on your first recording. Allow Accessibility access so FlowVoice can enter text into other applications.', requestPermission: 'Check & request permission',
  preferencesSaved: 'Preferences saved', shortcutConflictHint: 'You will be notified if the shortcut is already in use', saving: 'Saving…', savePreferences: 'Save preferences',
  cancelRecording: 'Cancel recording', listening: 'Listening',
  modelChoiceTitle: 'Your models, your choice', modelChoiceLocal: 'Local for privacy', modelChoiceCloud: 'Cloud for more capability', manageModels: 'Manage models', settingsHelp: 'View preferences and help',
  previewNotice: 'Browser preview · Recording, model downloads and saving require the desktop app.', dismissError: 'Dismiss error', footer: 'Less typing. More flow.', headingPunctuation: '.',
  desktopOnly: 'Use this feature in the FlowVoice desktop app. This browser is for interface preview only.', backendConnectionFailed: 'Could not connect to the desktop service',
  recordingShortcut: 'Recording global shortcut; press Esc to cancel', shortcutButton: 'Global recording shortcut', pressShortcut: 'Press a key combination; Esc to cancel',
  space: 'Space', chars: 'characters', charsPerMinute: 'chars/min', hours: 'h', minutes: 'm', seconds: 's',
};

export const translations: Record<Language, Translations> = { 'zh-CN': zhCN, 'zh-TW': zhTW, en };
export const languageOptions: { value: Language; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
];

export function useI18n() {
  const language = useAppStore((state) => state.snapshot.settings.language);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  return translations[language] || zhCN;
}
export function phaseLabel(t: Translations, phase: SessionPhase): string {
  return t[phase as TranslationKey] || phase;
}

export function durationLabel(t: Translations, ms: number, language: Language): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  if (language === 'en') {
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
  return h > 0 ? `${h}${t.hours}${m}${t.minutes}` : m > 0 ? `${m}${t.minutes}${s.toString().padStart(2, '0')}${t.seconds}` : `${s}${t.seconds}`;
}
