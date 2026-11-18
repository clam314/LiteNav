// Always excluded from character display; source: bd2_male_characters.json (2026-11-17).
export const EXCLUDED_MALE_CHARACTERS = [
  {
    "ids": [
      "lathel",
      "0001"
    ],
    "names": [
      "拉德尔",
      "拉德爾",
      "Lathel",
      "라텔",
      "ラテル"
    ]
  },
  {
    "ids": [
      "gray",
      "0004"
    ],
    "names": [
      "格雷",
      "Gray",
      "Gisgray Blair",
      "그레이",
      "グレイ",
      "ジスグレイ・ブレア",
      "雾中神射手"
    ]
  },
  {
    "ids": [
      "olstein",
      "0006"
    ],
    "names": [
      "奥尔施塔因",
      "奧爾施塔因",
      "Olstein",
      "올슈타인",
      "オルシュタイン",
      "猫爸"
    ]
  },
  {
    "ids": [
      "alec",
      "0603"
    ],
    "names": [
      "艾瑞克",
      "Alec",
      "알렉",
      "アレク",
      "破坏之星"
    ]
  },
  {
    "ids": [
      "nartas",
      "0658"
    ],
    "names": [
      "纳罗达斯",
      "納羅達斯",
      "Nartas",
      "나르타스",
      "ナルタス"
    ]
  },
  {
    "ids": [
      "goblin_slayer",
      "0206"
    ],
    "names": [
      "哥布林杀手",
      "哥布林殺手",
      "Goblin Slayer",
      "고블린 슬레이어"
    ]
  },
  {
    "ids": [
      "andrew",
      "0620"
    ],
    "names": [
      "安德鲁",
      "安德魯",
      "Andrew",
      "앤드류"
    ]
  },
  {
    "ids": [
      "jayden",
      "1012"
    ],
    "names": [
      "杰登",
      "傑登",
      "Jayden",
      "제이든"
    ]
  },
  {
    "ids": [
      "kry",
      "1015"
    ],
    "names": [
      "克莱",
      "克萊",
      "Kry",
      "크라이"
    ]
  },
  {
    "ids": [
      "fred",
      "1002"
    ],
    "names": [
      "弗雷德",
      "Fred",
      "프레드"
    ]
  },
  {
    "ids": [
      "gynt",
      "1001"
    ],
    "names": [
      "君特",
      "Gynt",
      "귄트"
    ]
  },
  {
    "ids": [
      "carlson",
      "1032"
    ],
    "names": [
      "卡森",
      "Carlson",
      "칼슨"
    ]
  },
  {
    "ids": [
      "remnunt",
      "1004"
    ],
    "names": [
      "雷南特",
      "Remnunt",
      "램넌트"
    ]
  },
  {
    "ids": [
      "wiggle",
      "1005"
    ],
    "names": [
      "威格",
      "Wiggle",
      "위글"
    ]
  },
  {
    "ids": [
      "storath"
    ],
    "names": [
      "斯托拉斯",
      "Storath",
      "스토라스",
      "ストラス"
    ]
  },
  {
    "ids": [
      "lugo_village_chief"
    ],
    "names": [
      "卢戈村长",
      "盧戈村長",
      "Village Elder Patrick"
    ]
  },
  {
    "ids": [
      "krau"
    ],
    "names": [
      "克劳",
      "克勞",
      "Krau"
    ]
  },
  {
    "ids": [
      "iron_mask_166"
    ],
    "names": [
      "铁面具166",
      "鐵面具166"
    ]
  },
  {
    "ids": [
      "gunfade"
    ],
    "names": [
      "坎佩德",
      "Gunfade",
      "건페이드"
    ]
  },
  {
    "ids": [
      "sword_king_lucius"
    ],
    "names": [
      "剑王卢修斯",
      "Sword King Lucius"
    ]
  },
  {
    "ids": [
      "the_captain"
    ],
    "names": [
      "队长",
      "隊長",
      "The Captain"
    ]
  },
  // NIKKE collaboration characters; scripts/update_companion.py also leaves them out.
  { "ids": ["nikke:c803", "nikke:c803_01"], "names": ["Denji", "电次", "電次"] },
  { "ids": ["nikke:c804"], "names": ["Aki Hayakawa", "早川秋"] },
  { "ids": ["nikke:c813"], "names": ["9S"] },
  { "ids": ["nikke:c853"], "names": ["Adam", "亚当"] }
];

const normalName = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');
const excludedIds = new Set(EXCLUDED_MALE_CHARACTERS.flatMap(character => character.ids));
const excludedNames = new Set(EXCLUDED_MALE_CHARACTERS.flatMap(character => character.names.map(normalName)));

export function isExcludedCharacter(character) {
  const value = String(character?.id ?? '');
  const id = /^\d+$/.test(value) ? value.padStart(4, '0') : value.toLowerCase();
  return excludedIds.has(id) || [character?.name, character?.aka].some(name => excludedNames.has(normalName(name)));
}
