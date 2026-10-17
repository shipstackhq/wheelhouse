/**
 * The app's icons, all Remix Icon (https://remixicon.com), under the names the app uses for them. Every screen imports from here, never
 * from the package, so changing an icon (or the whole set) is a change in this one file. They size with the text (1em), take the text
 * colour, and are hidden from screen readers: a control that holds only an icon needs its own aria-label.
 */
import clsx from "clsx";
import type { ComponentProps } from "react";
import {
  RiAddLine,
  RiAlertLine,
  RiArrowDownLine,
  RiArrowDownSLine,
  RiArrowGoBackLine,
  RiArrowGoForwardLine,
  RiArrowLeftLine,
  RiArrowLeftSLine,
  RiArrowRightLine,
  RiArrowRightSLine,
  RiArrowUpLine,
  RiArrowUpSFill,
  RiArrowDownSFill,
  RiBold,
  RiBookmarkLine,
  RiBookOpenLine,
  RiChat1Line,
  RiCheckboxCircleFill,
  RiFlowChart,
  RiMapLine,
  RiPlayFill,
  RiSubtractLine,
  RiCheckLine,
  RiCircleLine,
  RiCloseLine,
  RiCodeLine,
  RiCodeSSlashLine,
  RiDoubleQuotesL,
  RiEditLine,
  RiExpandDiagonalLine,
  RiFileTextLine,
  RiFolderLine,
  RiFormatClear,
  RiFullscreenExitLine,
  RiFullscreenLine,
  RiH1,
  RiH2,
  RiH3,
  RiImageLine,
  RiIndentDecrease,
  RiIndentIncrease,
  RiItalic,
  RiLinkM,
  RiListCheck2,
  RiListOrdered,
  RiListUnordered,
  RiMarkdownLine,
  RiMenuLine,
  RiMoreLine,
  RiNodeTree,
  RiParagraph,
  RiRobot2Line,
  RiSearchLine,
  RiSeparator,
  RiSparklingLine,
  RiStrikethrough,
  RiTable2,
  RiTicketLine,
} from "@remixicon/react";
import type { RemixiconComponentType } from "@remixicon/react";

type IconProps = ComponentProps<RemixiconComponentType>;

/** Wrap a Remix icon: sits inline with the text, never shrinks in a flex row, hidden from assistive technology. */
const icon = (Remix: RemixiconComponentType) =>
  function Icon({ className, ...rest }: IconProps) {
    return <Remix aria-hidden size="1em" className={clsx("inline-block shrink-0 align-[-0.125em]", className)} {...rest} />;
  };

// Actions and status
export const AddIcon = icon(RiAddLine);
export const CheckIcon = icon(RiCheckLine);
export const CloseIcon = icon(RiCloseLine);
export const EditIcon = icon(RiEditLine);
export const MenuIcon = icon(RiMenuLine);
export const MoreIcon = icon(RiMoreLine);
export const SearchIcon = icon(RiSearchLine);
export const WarningIcon = icon(RiAlertLine);
export const PendingIcon = icon(RiCircleLine);
export const AskIcon = icon(RiSparklingLine);
export const DoneIcon = icon(RiCheckboxCircleFill);
export const PlayIcon = icon(RiPlayFill);
export const TidyIcon = icon(RiFlowChart);
export const TrendUpIcon = icon(RiArrowUpSFill);
export const TrendDownIcon = icon(RiArrowDownSFill);
export const TrendFlatIcon = icon(RiSubtractLine);
// Things in the app
export const AgentIcon = icon(RiRobot2Line);
export const BookIcon = icon(RiBookOpenLine);
export const FileIcon = icon(RiFileTextLine);
export const FolderIcon = icon(RiFolderLine);
export const NodeIcon = icon(RiNodeTree);
export const TicketIcon = icon(RiTicketLine);
export const CommentIcon = icon(RiChat1Line);
export const TermIcon = icon(RiBookmarkLine);
export const MapIcon = icon(RiMapLine);
// Direction
export const ArrowUpIcon = icon(RiArrowUpLine);
export const ArrowDownIcon = icon(RiArrowDownLine);
export const ArrowLeftIcon = icon(RiArrowLeftLine);
export const ArrowRightIcon = icon(RiArrowRightLine);
export const ChevronDownIcon = icon(RiArrowDownSLine);
export const ChevronLeftIcon = icon(RiArrowLeftSLine);
export const ChevronRightIcon = icon(RiArrowRightSLine);
export const ExpandIcon = icon(RiExpandDiagonalLine);
// The editor toolbar
export const BoldIcon = icon(RiBold);
export const ItalicIcon = icon(RiItalic);
export const StrikethroughIcon = icon(RiStrikethrough);
export const InlineCodeIcon = icon(RiCodeLine);
export const CodeBlockIcon = icon(RiCodeSSlashLine);
export const ParagraphIcon = icon(RiParagraph);
export const Heading1Icon = icon(RiH1);
export const Heading2Icon = icon(RiH2);
export const Heading3Icon = icon(RiH3);
export const QuoteIcon = icon(RiDoubleQuotesL);
export const NumberedListIcon = icon(RiListOrdered);
export const BulletListIcon = icon(RiListUnordered);
export const TaskListIcon = icon(RiListCheck2);
export const OutdentIcon = icon(RiIndentDecrease);
export const IndentIcon = icon(RiIndentIncrease);
export const LinkIcon = icon(RiLinkM);
export const ImageIcon = icon(RiImageLine);
export const TableIcon = icon(RiTable2);
export const DividerIcon = icon(RiSeparator);
export const ClearFormattingIcon = icon(RiFormatClear);
export const UndoIcon = icon(RiArrowGoBackLine);
export const RedoIcon = icon(RiArrowGoForwardLine);
export const MarkdownIcon = icon(RiMarkdownLine);
export const FullscreenIcon = icon(RiFullscreenLine);
export const ExitFullscreenIcon = icon(RiFullscreenExitLine);
