package io.qzz.superstar1014.mynotes;

import android.graphics.Typeface;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.BackgroundColorSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.LeadingMarginSpan;
import android.text.style.RelativeSizeSpan;
import android.text.style.StrikethroughSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import android.text.style.UnderlineSpan;

/** Small, deterministic Markdown renderer for Hermes/Telegram-style chat messages. */
final class HermesChatMarkdown {
  private static final int SPAN_FLAGS = Spanned.SPAN_EXCLUSIVE_EXCLUSIVE;

  private HermesChatMarkdown() {}

  static CharSequence render(
    String source,
    int codeBackground,
    int codeForeground,
    int accent,
    int codeMarginPixels
  ) {
    String markdown = source == null ? "" : source.replace("\r\n", "\n").replace('\r', '\n');
    SpannableStringBuilder output = new SpannableStringBuilder();
    int cursor = 0;
    while (cursor < markdown.length()) {
      int fenceStart = markdown.indexOf("```", cursor);
      if (fenceStart < 0) {
        appendNormal(output, markdown.substring(cursor), accent, codeBackground, codeForeground);
        break;
      }
      appendNormal(
        output,
        markdown.substring(cursor, fenceStart),
        accent,
        codeBackground,
        codeForeground
      );

      int openingEnd = markdown.indexOf('\n', fenceStart + 3);
      if (openingEnd < 0) {
        appendNormal(
          output,
          markdown.substring(fenceStart),
          accent,
          codeBackground,
          codeForeground
        );
        break;
      }
      String language = markdown.substring(fenceStart + 3, openingEnd).trim();
      int closingStart = markdown.indexOf("```", openingEnd + 1);
      int codeEnd = closingStart < 0 ? markdown.length() : closingStart;
      String code = markdown.substring(openingEnd + 1, codeEnd);
      if (code.endsWith("\n")) code = code.substring(0, code.length() - 1);

      if (output.length() > 0 && output.charAt(output.length() - 1) != '\n') output.append('\n');
      int blockStart = output.length();
      if (!language.isEmpty()) output.append(language).append('\n');
      output.append(code.isEmpty() ? " " : code);
      int blockEnd = output.length();
      setSpan(output, new TypefaceSpan("monospace"), blockStart, blockEnd);
      setSpan(output, new BackgroundColorSpan(codeBackground), blockStart, blockEnd);
      setSpan(output, new ForegroundColorSpan(codeForeground), blockStart, blockEnd);
      setSpan(output, new RelativeSizeSpan(0.92f), blockStart, blockEnd);
      setSpan(
        output,
        new LeadingMarginSpan.Standard(codeMarginPixels, codeMarginPixels),
        blockStart,
        blockEnd
      );
      if (!language.isEmpty()) {
        setSpan(output, new StyleSpan(Typeface.BOLD), blockStart, blockStart + language.length());
        setSpan(output, new ForegroundColorSpan(accent), blockStart, blockStart + language.length());
      }
      output.append('\n');

      if (closingStart < 0) break;
      cursor = closingStart + 3;
      if (cursor < markdown.length() && markdown.charAt(cursor) == '\n') cursor += 1;
    }
    return output;
  }

  private static void appendNormal(
    SpannableStringBuilder output,
    String value,
    int accent,
    int inlineCodeBackground,
    int inlineCodeForeground
  ) {
    int cursor = 0;
    while (cursor < value.length()) {
      int lineEnd = value.indexOf('\n', cursor);
      boolean hasNewline = lineEnd >= 0;
      if (!hasNewline) lineEnd = value.length();
      String line = value.substring(cursor, lineEnd);
      int headingLevel = headingLevel(line);
      String content = headingLevel == 0 ? line : line.substring(headingLevel + 1);
      int start = output.length();
      appendInline(output, content, accent, inlineCodeBackground, inlineCodeForeground);
      int end = output.length();
      if (headingLevel > 0 && end > start) {
        setSpan(output, new StyleSpan(Typeface.BOLD), start, end);
        setSpan(output, new RelativeSizeSpan(1.18f - ((headingLevel - 1) * 0.05f)), start, end);
      }
      if (hasNewline) output.append('\n');
      cursor = lineEnd + (hasNewline ? 1 : 0);
    }
  }

  private static void appendInline(
    SpannableStringBuilder output,
    String value,
    int accent,
    int inlineCodeBackground,
    int inlineCodeForeground
  ) {
    int cursor = 0;
    while (cursor < value.length()) {
      if (value.charAt(cursor) == '\\' && cursor + 1 < value.length()) {
        output.append(value.charAt(cursor + 1));
        cursor += 2;
        continue;
      }
      if (value.charAt(cursor) == '`') {
        int close = value.indexOf('`', cursor + 1);
        if (close > cursor + 1) {
          int start = output.length();
          output.append(value, cursor + 1, close);
          int end = output.length();
          setSpan(output, new TypefaceSpan("monospace"), start, end);
          setSpan(output, new BackgroundColorSpan(inlineCodeBackground), start, end);
          setSpan(output, new ForegroundColorSpan(inlineCodeForeground), start, end);
          cursor = close + 1;
          continue;
        }
      }
      String pairedMarker = pairedMarkerAt(value, cursor);
      if (pairedMarker != null) {
        int close = value.indexOf(pairedMarker, cursor + pairedMarker.length());
        if (close > cursor + pairedMarker.length()) {
          int start = output.length();
          output.append(value, cursor + pairedMarker.length(), close);
          int end = output.length();
          if ("~~".equals(pairedMarker)) {
            setSpan(output, new StrikethroughSpan(), start, end);
          } else {
            setSpan(output, new StyleSpan(Typeface.BOLD), start, end);
          }
          cursor = close + pairedMarker.length();
          continue;
        }
      }
      char marker = value.charAt(cursor);
      if (marker == '*' || marker == '_') {
        int close = value.indexOf(marker, cursor + 1);
        if (close > cursor + 1) {
          int start = output.length();
          output.append(value, cursor + 1, close);
          setSpan(output, new StyleSpan(Typeface.ITALIC), start, output.length());
          cursor = close + 1;
          continue;
        }
      }
      if (marker == '[') {
        int labelEnd = value.indexOf("](", cursor + 1);
        int targetEnd = labelEnd < 0 ? -1 : value.indexOf(')', labelEnd + 2);
        if (labelEnd > cursor + 1 && targetEnd > labelEnd + 2) {
          int start = output.length();
          output.append(value, cursor + 1, labelEnd);
          int end = output.length();
          setSpan(output, new UnderlineSpan(), start, end);
          setSpan(output, new ForegroundColorSpan(accent), start, end);
          cursor = targetEnd + 1;
          continue;
        }
      }
      output.append(marker);
      cursor += 1;
    }
  }

  private static int headingLevel(String line) {
    int level = 0;
    while (level < line.length() && level < 3 && line.charAt(level) == '#') level += 1;
    return level > 0 && level < line.length() && line.charAt(level) == ' ' ? level : 0;
  }

  private static String pairedMarkerAt(String value, int offset) {
    if (offset + 1 >= value.length()) return null;
    String marker = value.substring(offset, offset + 2);
    return "**".equals(marker) || "__".equals(marker) || "~~".equals(marker)
      ? marker
      : null;
  }

  private static void setSpan(
    SpannableStringBuilder value,
    Object span,
    int start,
    int end
  ) {
    if (end > start) value.setSpan(span, start, end, SPAN_FLAGS);
  }
}
