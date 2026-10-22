/**
 * The app's icons, all Remix Icon (https://remixicon.com), under the names the app uses for them. Every screen imports from here, never
 * from the package, so changing an icon (or the whole set) is a change in this one file. They size with the text (1em), take the text
 * colour, and are hidden from screen readers: a control that holds only an icon needs its own aria-label.
 */
import clsx from "clsx";
import type { ComponentProps } from "react";
import {
  RiAddLine,
  RiClaudeFill,
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
  RiRobot3Line,
  RiSearchLine,
  RiFilter3Line,
  RiMailLine,
  RiLockLine,
  RiEyeLine,
  RiEyeOffLine,
  RiSeparator,
  RiSparklingLine,
  RiStrikethrough,
  RiTable2,
  RiRecordCircleLine,
  RiRecordCircleFill,
  RiHome4Line,
  RiHome4Fill,
  RiDashboardLine,
  RiDashboardFill,
  RiLayoutColumnLine,
  RiLayoutColumnFill,
  RiHistoryLine,
  RiHistoryFill,
  RiMapFill,
  RiFileTextFill,
  RiScales3Line,
  RiScales3Fill,
  RiBookmarkFill,
  RiTeamLine,
  RiTeamFill,
  RiSettings3Line,
  RiSettings3Fill,
  RiUserLine,
  RiLockPasswordLine,
  RiLockPasswordFill,
  RiMacbookLine,
  RiMacbookFill,
  RiGithubLine,
  RiGithubFill,
  RiGroup2Line,
  RiGroup2Fill,
  RiRobot2Fill,
  RiRobot3Fill,
  RiBuilding2Line,
  RiBuilding2Fill,
  RiLoopRightLine,
  RiRocket2Line,
  RiFlag2Line,
  RiBox3Fill,
  RiMoreFill,
  RiFlag2Fill,
  RiRocket2Fill,
  RiLoopRightFill,
  RiMailAddLine,
  RiMailAddFill,
  RiSidebarFoldLine,
  RiNotification3Line,
  RiSidebarUnfoldLine,
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
export const FilterIcon = icon(RiFilter3Line);
export const MailIcon = icon(RiMailLine);
export const NotificationsIcon = icon(RiNotification3Line);
export const LockIcon = icon(RiLockLine);
export const EyeIcon = icon(RiEyeLine);
export const EyeOffIcon = icon(RiEyeOffLine);
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
export const IssueIcon = icon(RiRecordCircleLine);
export const IssueFillIcon = icon(RiRecordCircleFill);
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

// Navigation (the sidebar): each place has an outline icon and a solid one; the place you are on shows the solid one.
export const HomeIcon = icon(RiHome4Line);
export const HomeFillIcon = icon(RiHome4Fill);
export const OverviewIcon = icon(RiDashboardLine);
export const OverviewFillIcon = icon(RiDashboardFill);
export const BoardIcon = icon(RiLayoutColumnLine);
export const BoardFillIcon = icon(RiLayoutColumnFill);
// History, not Pulse: Remix's Pulse has no distinct solid variant, so it could not show that Activity is selected.
export const ActivityIcon = icon(RiHistoryLine);
export const ActivityFillIcon = icon(RiHistoryFill);
export const MapFillIcon = icon(RiMapFill);
export const FileFillIcon = icon(RiFileTextFill);
export const DecisionsIcon = icon(RiScales3Line);
export const DecisionsFillIcon = icon(RiScales3Fill);
export const TermFillIcon = icon(RiBookmarkFill);
export const TeamMembersIcon = icon(RiTeamLine);
export const TeamMembersFillIcon = icon(RiTeamFill);
export const SettingsIcon = icon(RiSettings3Line);
export const SettingsFillIcon = icon(RiSettings3Fill);
export const PeopleIcon = icon(RiGroup2Line);
export const PeopleFillIcon = icon(RiGroup2Fill);
export const AgentFillIcon = icon(RiRobot2Fill);
export const WorkspacesIcon = icon(RiBuilding2Line);
export const WorkspacesFillIcon = icon(RiBuilding2Fill);
export const InviteWorkspaceIcon = icon(RiMailAddLine);
export const InviteWorkspaceFillIcon = icon(RiMailAddFill);
export const ProjectsIcon = icon(RiRocket2Line);
export const ProjectsFillIcon = icon(RiRocket2Fill);
/** A stand-in for a team's own icon, until a team can be given one. */
export const TeamGlyphIcon = icon(RiBox3Fill);
export const MoreFillIcon = icon(RiMoreFill);
export const InitiativesIcon = icon(RiFlag2Line);
export const InitiativesFillIcon = icon(RiFlag2Fill);
export const CyclesIcon = icon(RiLoopRightLine);
export const CyclesFillIcon = icon(RiLoopRightFill);
export const CollapseSidebarIcon = icon(RiSidebarFoldLine);
export const ExpandSidebarIcon = icon(RiSidebarUnfoldLine);

/** An outline icon and its solid twin. */
export type IconPair = { line: ReturnType<typeof icon>; fill: ReturnType<typeof icon> };
export const NAV_ICONS = {
  home: { line: HomeIcon, fill: HomeFillIcon },
  overview: { line: OverviewIcon, fill: OverviewFillIcon },
  issues: { line: IssueIcon, fill: IssueFillIcon },
  cycles: { line: CyclesIcon, fill: CyclesFillIcon },
  projects: { line: ProjectsIcon, fill: ProjectsFillIcon },
  initiatives: { line: InitiativesIcon, fill: InitiativesFillIcon },
  activity: { line: ActivityIcon, fill: ActivityFillIcon },
  map: { line: MapIcon, fill: MapFillIcon },
  docs: { line: FileIcon, fill: FileFillIcon },
  decisions: { line: DecisionsIcon, fill: DecisionsFillIcon },
  glossary: { line: TermIcon, fill: TermFillIcon },
  teamMembers: { line: TeamMembersIcon, fill: TeamMembersFillIcon },
  teamSettings: { line: SettingsIcon, fill: SettingsFillIcon },
  settings: { line: SettingsIcon, fill: SettingsFillIcon },
  people: { line: PeopleIcon, fill: PeopleFillIcon },
  agents: { line: icon(RiRobot3Line), fill: icon(RiRobot3Fill) },
  workspaces: { line: WorkspacesIcon, fill: WorkspacesFillIcon },
  inviteWorkspace: { line: InviteWorkspaceIcon, fill: InviteWorkspaceFillIcon },
} satisfies Record<string, IconPair>;

/** The sections of Settings, in its left panel. */
export const SETTINGS_ICONS = {
  profile: { line: icon(RiUserLine), fill: icon(RiUserFill) },
  password: { line: icon(RiLockPasswordLine), fill: icon(RiLockPasswordFill) },
  devices: { line: icon(RiMacbookLine), fill: icon(RiMacbookFill) },
  general: NAV_ICONS.settings,
  members: NAV_ICONS.people,
  agents: NAV_ICONS.agents,
  teams: { line: icon(RiTeamLine), fill: icon(RiTeamFill) },
} satisfies Record<string, IconPair>;

/** The services under Settings → Integrations, by integration id. */
export const INTEGRATION_ICONS = {
  github: { line: icon(RiGithubLine), fill: icon(RiGithubFill) },
} satisfies Record<string, IconPair>;

// ───────── team icons ─────────
// The solid icons a team can choose (WH-120 follow-up), by the name stored with the team (the server's list, `TEAM_ICON_NAMES`).
// They are here, not in a component, because this is the one file that imports the icon package.
import {
  RiAnchorFill,
  RiBankCardFill,
  RiBarChartFill,
  RiBook2Fill,
  RiBrushFill,
  RiBugFill,
  RiCalendarFill,
  RiCameraFill,
  RiCarFill,
  RiChat1Fill,
  RiCloudFill,
  RiCodeBoxFill,
  RiCompass3Fill,
  RiCpuFill,
  RiCustomerService2Fill,
  RiDatabase2Fill,
  RiFireFill,
  RiFlashlightFill,
  RiGamepadFill,
  RiGiftFill,
  RiGlobalFill,
  RiGraduationCapFill,
  RiHeartFill,
  RiHome2Fill,
  RiKey2Fill,
  RiLeafFill,
  RiLightbulbFill,
  RiLineChartFill,
  RiLockFill,
  RiMagicFill,
  RiMailFill,
  RiMapPin2Fill,
  RiMedalFill,
  RiMegaphoneFill,
  RiMusic2Fill,
  RiPaletteFill,
  RiPieChartFill,
  RiPlaneFill,
  RiPlantFill,
  RiPuzzleFill,
  RiServerFill,
  RiShieldFill,
  RiShipFill,
  RiShoppingCartFill,
  RiStarFill,
  RiStethoscopeFill,
  RiStore2Fill,
  RiSunFill,
  RiTerminalBoxFill,
  RiTimeFill,
  RiToolsFill,
  RiTrophyFill,
  RiUserFill,
  RiWalletFill,
} from "@remixicon/react";
import type { TeamIconName } from "@wheelhouse/core/lib/team-icon";

export const TEAM_ICONS: Record<TeamIconName, RemixiconComponentType> = {
  "rocket-2": RiRocket2Fill, "box-3": RiBox3Fill, "flag-2": RiFlag2Fill, star: RiStarFill, heart: RiHeartFill, flashlight: RiFlashlightFill, fire: RiFireFill, leaf: RiLeafFill, plant: RiPlantFill,
  global: RiGlobalFill, cloud: RiCloudFill, shield: RiShieldFill, lock: RiLockFill, key: RiKey2Fill, mail: RiMailFill, "chat-1": RiChat1Fill, "bank-card": RiBankCardFill, wallet: RiWalletFill,
  "shopping-cart": RiShoppingCartFill, "store-2": RiStore2Fill, tools: RiToolsFill, "settings-3": RiSettings3Fill, "code-box": RiCodeBoxFill, "terminal-box": RiTerminalBoxFill, bug: RiBugFill,
  "database-2": RiDatabase2Fill, server: RiServerFill, cpu: RiCpuFill, palette: RiPaletteFill, brush: RiBrushFill, camera: RiCameraFill, "music-2": RiMusic2Fill, gamepad: RiGamepadFill, book: RiBook2Fill,
  "graduation-cap": RiGraduationCapFill, stethoscope: RiStethoscopeFill, plane: RiPlaneFill, car: RiCarFill, ship: RiShipFill, home: RiHome2Fill, "building-2": RiBuilding2Fill, "map-pin": RiMapPin2Fill,
  "compass-3": RiCompass3Fill, lightbulb: RiLightbulbFill, magic: RiMagicFill, trophy: RiTrophyFill, medal: RiMedalFill, "line-chart": RiLineChartFill, "pie-chart": RiPieChartFill, "bar-chart": RiBarChartFill,
  time: RiTimeFill, calendar: RiCalendarFill, anchor: RiAnchorFill, puzzle: RiPuzzleFill, user: RiUserFill, team: RiTeamFill, "customer-service": RiCustomerService2Fill, megaphone: RiMegaphoneFill, gift: RiGiftFill, sun: RiSunFill,
};

// The Claude mark, for naming a Claude model (the run picker and each run's row).
export const ClaudeIcon = icon(RiClaudeFill);
