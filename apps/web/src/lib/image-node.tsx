/**
 * An inline image in the rich editor, stored as Markdown `![alt](src)`. Lexical has no image node of its own;
 * this one only shows the picture, so the Markdown is what the agents read and what is saved.
 */
import type { JSX } from "react";
import type { TextMatchTransformer } from "@lexical/markdown";
import { $applyNodeReplacement, DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";

type SerializedImageNode = Spread<{ src: string; alt: string; title?: string }, SerializedLexicalNode>;

export class ImageNode extends DecoratorNode<JSX.Element> {
  __src: string;
  __alt: string;
  __title: string;

  static getType() {
    return "image";
  }
  static clone(node: ImageNode) {
    return new ImageNode(node.__src, node.__alt, node.__title, node.__key);
  }
  static importJSON(json: SerializedImageNode) {
    return $createImageNode(json.src, json.alt, json.title);
  }

  constructor(src: string, alt: string, title = "", key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__alt = alt;
    this.__title = title;
  }

  exportJSON(): SerializedImageNode {
    return { ...super.exportJSON(), type: "image", version: 1, src: this.__src, alt: this.__alt, title: this.__title };
  }
  createDOM() {
    const span = document.createElement("span");
    span.className = "inline-block max-w-full align-bottom";
    return span;
  }
  updateDOM() {
    return false;
  }
  isInline() {
    return true;
  }
  getTextContent() {
    return markdownOf(this);
  }
  decorate() {
    return <img src={this.__src} alt={this.__alt} title={this.__title || undefined} className="max-h-[28rem] max-w-full rounded-md border border-line" draggable={false} />;
  }
}

/** `![alt](src)` or `![alt](src "title")`. */
const markdownOf = (n: ImageNode) => `![${n.__alt}](${n.__src}${n.__title ? ` "${n.__title}"` : ""})`;

export const $createImageNode = (src: string, alt = "", title = "") => $applyNodeReplacement(new ImageNode(src, alt, title));
export const $isImageNode = (node: LexicalNode | null | undefined): node is ImageNode => node instanceof ImageNode;

/** `![alt](src)`, in both directions. Must come before the link transformer, whose pattern would match the `[alt](src)` part. */
export const IMAGE_TRANSFORMER: TextMatchTransformer = {
  dependencies: [ImageNode],
  export: (node) => ($isImageNode(node) ? markdownOf(node) : null),
  importRegExp: /!\[([^[\]]*)\]\(\s*([^()\s]+)(?:\s+"([^"]*)")?\s*\)/,
  regExp: /!\[([^[\]]*)\]\(\s*([^()\s]+)(?:\s+"([^"]*)")?\s*\)$/,
  replace: (textNode, match) => {
    const [, alt, src, title] = match;
    textNode.replace($createImageNode(src, alt, title ?? ""));
  },
  trigger: ")",
  type: "text-match",
};
