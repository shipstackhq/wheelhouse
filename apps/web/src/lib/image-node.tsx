/**
 * An inline image in the rich editor, stored as Markdown `![alt](src)`. Lexical has no image node of its own;
 * this one only shows the picture, so the Markdown is what the agents read and what is saved.
 */
import type { JSX } from "react";
import type { TextMatchTransformer } from "@lexical/markdown";
import { $applyNodeReplacement, DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";

type SerializedImageNode = Spread<{ src: string; alt: string }, SerializedLexicalNode>;

export class ImageNode extends DecoratorNode<JSX.Element> {
  __src: string;
  __alt: string;

  static getType() {
    return "image";
  }
  static clone(node: ImageNode) {
    return new ImageNode(node.__src, node.__alt, node.__key);
  }
  static importJSON(json: SerializedImageNode) {
    return $createImageNode(json.src, json.alt);
  }

  constructor(src: string, alt: string, key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__alt = alt;
  }

  exportJSON(): SerializedImageNode {
    return { ...super.exportJSON(), type: "image", version: 1, src: this.__src, alt: this.__alt };
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
    return `![${this.__alt}](${this.__src})`;
  }
  decorate() {
    return <img src={this.__src} alt={this.__alt} className="max-h-[28rem] max-w-full rounded-md border border-line" draggable={false} />;
  }
}

export const $createImageNode = (src: string, alt = "") => $applyNodeReplacement(new ImageNode(src, alt));
export const $isImageNode = (node: LexicalNode | null | undefined): node is ImageNode => node instanceof ImageNode;

/** `![alt](src)`, in both directions. Must come before the link transformer, whose pattern would match the `[alt](src)` part. */
export const IMAGE_TRANSFORMER: TextMatchTransformer = {
  dependencies: [ImageNode],
  export: (node) => ($isImageNode(node) ? `![${node.__alt}](${node.__src})` : null),
  importRegExp: /!\[([^[\]]*)\]\(([^()\s]+)\)/,
  regExp: /!\[([^[\]]*)\]\(([^()\s]+)\)$/,
  replace: (textNode, match) => {
    const [, alt, src] = match;
    textNode.replace($createImageNode(src, alt));
  },
  trigger: ")",
  type: "text-match",
};
