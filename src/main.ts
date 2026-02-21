import { Editor, MarkdownView, Notice, Plugin, TFile, TAbstractFile } from 'obsidian';
import { PluginSettings, TranscriptResponse } from './types';

import { SettingsTab } from './ui/settings';
import { YouTubeService } from './services/youtube';
import { YouTubeURLModal } from './ui/modals/youtube-url';
import { PromptService } from './services/prompt';
import { SettingsManager } from './services/settingsManager';
import { ProvidersFactory } from './services/providers/providersFactory';
import { AIModelProvider } from './types';

/**
 * Represents the YouTube Summarizer Plugin.
 * This class extends the Plugin class and provides the main functionality
 * for the YouTube Summarizer Plugin.
 */
export class YouTubeSummarizerPlugin extends Plugin {
	settings: PluginSettings;
	private youtubeService: YouTubeService;
	private promptService: PromptService;
	private provider: AIModelProvider | null = null;
	private isProcessing = false;

	/**
	 * Called when the plugin is loaded.
	 */
	async onload() {
		try {
			// Initialize services
			await this.initializeServices();

			// Add settings tab
			this.addSettingTab(new SettingsTab(this.app, this));

			// Register commands
			this.registerCommands();

			// Register event listeners
			this.registerEvents();
		} catch (error) {
			new Notice(`Error: ${error.message}`);
		}
	}

	/**
	 * Registers event listeners for auto-summarization.
	 */
	private registerEvents(): void {
		// Listen for file changes to detect YouTube URLs in frontmatter
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => this.handleFileChange(file))
		);

		// Listen for paste events to detect YouTube URLs
		this.registerEvent(
			this.app.workspace.on('editor-paste', (evt, editor) => this.handlePaste(evt, editor))
		);
	}

	public async saveData(data: any): Promise<void> {
		await super.saveData(data);
		await this.initializeServices();
	}

	/**
	 * Initializes the plugin services.
	 * This method creates instances of the required services and loads the plugin settings.
	 * @returns {Promise<void>} A promise that resolves when the services are initialized.
	 * @throws {Error} Throws an error if the services cannot be initialized.
	 */
	public async initializeServices(): Promise<void> {
		// Initialize settings manager
		this.settings = new SettingsManager(this);
		await this.settings.loadSettings();
		// Initialize youtube service
		this.youtubeService = new YouTubeService();

		// Initialize prompt service
		this.promptService = new PromptService(this.settings.getCustomPrompt());

		// Initialize AI provider
		const selectedModel = this.settings.getSelectedModel();
		if (selectedModel) {
			this.provider = ProvidersFactory.createProvider(selectedModel, this.settings.getMaxTokens(), this.settings.getTemperature());
		}
	}

	/**
	 * Registers the plugin commands.
	 * This method adds the commands to the Obsidian app.
	 * @returns {void}
	 */
	private registerCommands(): void {
		// Register the summarize command
		// Command to summarize a YouTube video from URL
		this.addCommand({
			id: 'summarize-youtube-video',
			name: 'Summarize youtube video',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				try {
					const selectedText = editor.getSelection().trim();
					if (
						selectedText &&
						YouTubeService.isYouTubeUrl(selectedText)
					) {
						await this.summarizeVideo(selectedText, editor);
					} else if (selectedText) {
						new Notice('Selected text is not a valid YouTube URL');
					} else {
						new YouTubeURLModal(this.app, async (url) => {
							await this.summarizeVideo(url, editor);
						}).open();
					}
				} catch (error) {
					new Notice(`Failed to process video: ${error.message}`);
					console.error('Failed to process video:', error);
				}
			},
		});

		// Command to summarize a YouTube video with custom prompt
		this.addCommand({
			id: 'summarize-youtube-video-prompt',
			name: 'Summarize youtube video (with prompt)',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				try {
					const selectedText = editor.getSelection().trim();
					if (
						selectedText &&
						YouTubeService.isYouTubeUrl(selectedText)
					) {
						await this.summarizeVideo(selectedText, editor);
					} else if (selectedText) {
						new Notice('Selected text is not a valid YouTube URL');
					} else {
						new YouTubeURLModal(this.app, async (url) => {
							await this.summarizeVideo(url, editor);
						}).open();
					}
				} catch (error) {
					new Notice(`Failed to process video: ${error.message}`);
					console.error('Failed to process video:', error);
				}
			},
		});
	}

	/**
	 * Summarizes the YouTube video for the given URL and updates the markdown view with the summary.
	 * @param url - The URL of the YouTube video to summarize.
	 * @param editor - The editor instance where the summary will be inserted.
	 * @returns {Promise<void>} A promise that resolves when the video is summarized.
	 */
	private async summarizeVideo(url: string, editor: Editor): Promise<void> {
		const content = await this.processVideoSummarization(url);
		if (content) {
			editor.replaceSelection(content);
			new Notice('Summary generated successfully!');
		}
	}

	/**
	 * Core logic for fetching transcript and generating summary for a YouTube video.
	 * @param url - The URL of the YouTube video to summarize.
	 * @returns {Promise<string | null>} A promise that resolves with the formatted summary content, or null if it fails.
	 */
	private async processVideoSummarization(url: string): Promise<string | null> {
		// Check if a video is already being processed
		if (this.isProcessing) {
			new Notice('Already processing a video, please wait...');
			return null;
		}

		try {
			this.isProcessing = true;
			// Get the selected model
			const selectedModel = this.settings.getSelectedModel();

			if (!selectedModel) {
				new Notice('No AI model selected. Please select a model in the plugin settings.');
				return null;
			}

			// Check if the selected model's provider has an API key
			if (!selectedModel.provider.apiKey) {
				new Notice(
					`${selectedModel.provider.name} API key is missing. Please set it in the plugin settings.`
				);
				return null;
			}

			if (!this.provider) {
				new Notice('AI provider not initialized. Please check your settings.');
				return null;
			}

			// Fetch the video transcript
			new Notice('Fetching video transcript...');
			let transcript: TranscriptResponse;
			try {
				transcript = await this.youtubeService.fetchTranscript(url);
			} catch (error) {
				new Notice(`Error: ${error.message}`);
				return null;
			}
			const thumbnailUrl = YouTubeService.getThumbnailUrl(
				transcript.videoId
			);

			//Build the prompt for LLM
			const prompt = this.promptService.buildPrompt(transcript.lines.map((line) => line.text).join(' '));
			// Generate the summary using the provider
			new Notice('Generating summary...');
			let summary: string;
			try {
				summary = await this.provider.summarizeVideo(transcript.videoId, prompt);
			} catch (error) {
				new Notice(`Error: ${error.message}`);
				console.error('Failed to generate summary:', error);
				return null;
			}

			// Create the summary content
			return this.generateSummary(
				transcript,
				thumbnailUrl,
				url,
				summary
			);
		} catch (error) {
			new Notice(`Error: ${error.message}`);
			console.error('Summary generation failed:', error);
			return null;
		} finally {
			// Reset the processing flag
			this.isProcessing = false;
		}
	}

	/**
	 * Checks if a file has already been summarized by this plugin.
	 * @param file - The file to check.
	 * @returns True if the file has the 'yt-summarized' marker in its frontmatter.
	 */
	private isAlreadySummarized(file: TFile): boolean {
		const cache = this.app.metadataCache.getFileCache(file);
		return cache?.frontmatter?.['yt-summarized'] === true;
	}

	/**
	 * Handler for file changes to detect YouTube URLs in frontmatter and auto-summarize.
	 * @param file - The file that changed.
	 */
	private async handleFileChange(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile)) return;
		if (!this.settings.getAutoSummarizeWebclips()) return;

		const cache = this.app.metadataCache.getFileCache(file);
		const source = cache?.frontmatter?.source;

		if (source && YouTubeService.isYouTubeUrl(source)) {
			if (this.isAlreadySummarized(file)) return;

			const content = await this.processVideoSummarization(source);
			if (content) {
				await this.app.vault.append(file, '\n' + content);
				await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
					frontmatter['yt-summarized'] = true;
				});
				new Notice('Auto-summary generated for webclip!');
			}
		}
	}

	/**
	 * Handler for paste events in the editor to detect YouTube URLs and auto-summarize.
	 * @param evt - The clipboard event.
	 * @param editor - The editor instance.
	 */
	private async handlePaste(evt: ClipboardEvent, editor: Editor): Promise<void> {
		if (!this.settings.getAutoSummarizePastedUrls()) return;

		const pastedText = evt.clipboardData?.getData('text');
		if (pastedText && YouTubeService.isYouTubeUrl(pastedText.trim())) {
			// Small delay to allow the paste to complete before appending the summary
			setTimeout(async () => {
				await this.summarizeVideo(pastedText.trim(), editor);
			}, 100);
		}
	}

	/**
	 * Generates a summary string based on the provided transcript, thumbnail URL, video URL, and Gemini summary.
	 *
	 * @param transcript - The transcript response containing the title and author.
	 * @param thumbnailUrl - The URL of the thumbnail image.
	 * @param url - The URL of the video.
	 * @param summaryText - The Gemini response containing the summary, key points, technical terms, and conclusion.
	 * @returns A formatted summary string.
	 */
	private generateSummary(
		transcript: TranscriptResponse,
		thumbnailUrl: string,
		url: string,
		summaryText: string
	): string {
		// Initialize summary parts with title, thumbnail, video link, author, and summary
		const summaryParts = [
			`# ${transcript.title}\n`,
			`![Thumbnail](${thumbnailUrl})\n`,
			`👤 [${transcript.author}](${transcript.channelUrl})  🔗 [Watch video](${url})`,
			summaryText,
		];

		return summaryParts.join('\n');
	}
}

export default YouTubeSummarizerPlugin;
