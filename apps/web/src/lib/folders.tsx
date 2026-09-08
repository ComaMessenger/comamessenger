import type { ChatFolder } from "@comamessenger/core";
import {
  BookOpen,
  Bookmark,
  Bot,
  BriefcaseBusiness,
  CalendarDays,
  Camera,
  Car,
  Cat,
  ChartNoAxesCombined,
  CheckCircle2,
  Clock3,
  Cloud,
  Code2,
  Coffee,
  Database,
  Dog,
  Dumbbell,
  Flame,
  Flower2,
  Folder,
  Gamepad2,
  Gift,
  Globe2,
  GraduationCap,
  Hash,
  Heart,
  Home,
  Image,
  Leaf,
  Lightbulb,
  Map as MapIcon,
  Moon,
  Mountain,
  Music,
  Palette,
  PartyPopper,
  Plane,
  Rocket,
  ShoppingBag,
  Smile,
  Star,
  Sun,
  Target,
  Terminal,
  Trophy,
  Umbrella,
  Users,
  Wallet,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";

export type FolderIconOption = {
  id: ChatFolder["icon"];
  icon: LucideIcon;
  labelKey: string;
  terms: string;
};

export const folderIconOptions: FolderIconOption[] = [
  { id: "folder", icon: Folder, labelKey: "folderIconFolder", terms: "folder directory" },
  { id: "briefcase", icon: BriefcaseBusiness, labelKey: "folderIconWork", terms: "work office briefcase" },
  { id: "heart", icon: Heart, labelKey: "folderIconHeart", terms: "heart love favorite" },
  { id: "star", icon: Star, labelKey: "folderIconStar", terms: "star important favorite" },
  { id: "users", icon: Users, labelKey: "folderIconPeople", terms: "users people team family group" },
  { id: "hash", icon: Hash, labelKey: "folderIconChannel", terms: "hash channel topic" },
  { id: "bookmark", icon: Bookmark, labelKey: "folderIconBookmark", terms: "bookmark save" },
  { id: "home", icon: Home, labelKey: "folderIconHome", terms: "home family" },
  { id: "rocket", icon: Rocket, labelKey: "folderIconRocket", terms: "rocket launch startup" },
  { id: "zap", icon: Zap, labelKey: "folderIconZap", terms: "zap fast energy" },
  { id: "flame", icon: Flame, labelKey: "folderIconFlame", terms: "flame hot urgent" },
  { id: "sun", icon: Sun, labelKey: "folderIconSun", terms: "sun day" },
  { id: "moon", icon: Moon, labelKey: "folderIconMoon", terms: "moon night" },
  { id: "cloud", icon: Cloud, labelKey: "folderIconCloud", terms: "cloud infrastructure" },
  { id: "umbrella", icon: Umbrella, labelKey: "folderIconUmbrella", terms: "umbrella vacation rest" },
  { id: "coffee", icon: Coffee, labelKey: "folderIconCoffee", terms: "coffee break" },
  { id: "music", icon: Music, labelKey: "folderIconMusic", terms: "music audio" },
  { id: "camera", icon: Camera, labelKey: "folderIconCamera", terms: "camera photo" },
  { id: "image", icon: Image, labelKey: "folderIconImage", terms: "image design photo" },
  { id: "gamepad", icon: Gamepad2, labelKey: "folderIconGamepad", terms: "game play" },
  { id: "dumbbell", icon: Dumbbell, labelKey: "folderIconSport", terms: "sport fitness gym" },
  { id: "trophy", icon: Trophy, labelKey: "folderIconTrophy", terms: "trophy win achievement" },
  { id: "target", icon: Target, labelKey: "folderIconTarget", terms: "target goal plan" },
  { id: "gift", icon: Gift, labelKey: "folderIconGift", terms: "gift holiday" },
  { id: "shopping-bag", icon: ShoppingBag, labelKey: "folderIconShopping", terms: "shopping store" },
  { id: "wallet", icon: Wallet, labelKey: "folderIconWallet", terms: "wallet finance money" },
  { id: "plane", icon: Plane, labelKey: "folderIconTravel", terms: "plane travel vacation" },
  { id: "car", icon: Car, labelKey: "folderIconCar", terms: "car auto" },
  { id: "map", icon: MapIcon, labelKey: "folderIconMap", terms: "map place geography" },
  { id: "globe", icon: Globe2, labelKey: "folderIconGlobe", terms: "globe world internet international" },
  { id: "book", icon: BookOpen, labelKey: "folderIconBook", terms: "book knowledge read" },
  { id: "graduation", icon: GraduationCap, labelKey: "folderIconEducation", terms: "education university study" },
  { id: "code", icon: Code2, labelKey: "folderIconCode", terms: "code development engineering" },
  { id: "terminal", icon: Terminal, labelKey: "folderIconTerminal", terms: "terminal console devops" },
  { id: "database", icon: Database, labelKey: "folderIconDatabase", terms: "database data sql" },
  { id: "chart", icon: ChartNoAxesCombined, labelKey: "folderIconAnalytics", terms: "chart analytics metrics" },
  { id: "calendar", icon: CalendarDays, labelKey: "folderIconCalendar", terms: "calendar meeting date" },
  { id: "clock", icon: Clock3, labelKey: "folderIconClock", terms: "clock time deadline" },
  { id: "check", icon: CheckCircle2, labelKey: "folderIconTasks", terms: "check task done todo" },
  { id: "lightbulb", icon: Lightbulb, labelKey: "folderIconIdeas", terms: "idea lightbulb" },
  { id: "palette", icon: Palette, labelKey: "folderIconDesign", terms: "palette design creative" },
  { id: "smile", icon: Smile, labelKey: "folderIconSocial", terms: "smile social chat" },
  { id: "bot", icon: Bot, labelKey: "folderIconBots", terms: "bot agent ai" },
  { id: "cat", icon: Cat, labelKey: "folderIconCats", terms: "cat pet" },
  { id: "dog", icon: Dog, labelKey: "folderIconDogs", terms: "dog pet" },
  { id: "leaf", icon: Leaf, labelKey: "folderIconNature", terms: "leaf nature ecology" },
  { id: "flower", icon: Flower2, labelKey: "folderIconFlowers", terms: "flower garden" },
  { id: "mountain", icon: Mountain, labelKey: "folderIconMountain", terms: "mountain hiking" },
  { id: "waves", icon: Waves, labelKey: "folderIconSea", terms: "waves sea water" },
  { id: "party", icon: PartyPopper, labelKey: "folderIconParty", terms: "party holiday" },
];

/** The first row of the picker; the rest is revealed on demand. */
export const featuredFolderIconCount = 10;

export const folderColors: ChatFolder["color"][] = [
  "blue",
  "green",
  "amber",
  "red",
  "violet",
  "teal",
  "orange",
  "pink",
  "cyan",
  "slate",
];

export function FolderGlyph({
  icon,
  size,
}: {
  icon: ChatFolder["icon"];
  size?: number;
}) {
  const Glyph =
    folderIconOptions.find((option) => option.id === icon)?.icon ?? Folder;
  return <Glyph size={size} aria-hidden="true" />;
}
