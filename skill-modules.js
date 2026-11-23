/* -------------------------------------------------------------
   模块化技能系统：模块定义 / 图编译 / 预设
   - 后台技能编辑器与游戏运行时共用同一份 schema 与编译器
   - 技能 = 节点图：source(触发) → element/damage/projectile/fx/particles/impact → stats
   - 同类节点叠加：数值相加、布尔取或、枚举取最后一个；元素/特效/粒子可挂多个
   ------------------------------------------------------------- */
(function (root) {
  'use strict';

  function n(key, label, def, min, max, step, hint) {
    return { key: key, label: label, type: 'number', def: def, min: min, max: max, step: step == null ? 1 : step, hint: hint };
  }
  function sel(key, label, def, options, hint) {
    return { key: key, label: label, type: 'select', def: def, options: options, hint: hint };
  }
  function b(key, label, def, hint) { return { key: key, label: label, type: 'bool', def: def, hint: hint }; }
  function c(key, label, def, hint) { return { key: key, label: label, type: 'color', def: def, hint: hint }; }
  function t(key, label, def, hint) { return { key: key, label: label, type: 'text', def: def == null ? '' : def, hint: hint }; }
  // image：内嵌 dataURL 的 PNG 素材（后台负责校验格式与体积，编译期原样透传给运行时）
  function img(key, label, def, hint) { return { key: key, label: label, type: 'image', def: def == null ? '' : def, hint: hint }; }
  function ramp(key, label, def, hint) { return { key: key, label: label, type: 'ramp', def: def, hint: hint }; }

  var ELEMENTS = [
    ['fire', '火焰'], ['ice', '冰霜'], ['lightning', '闪电'], ['poison', '剧毒'],
    ['holy', '神圣'], ['shadow', '暗影'], ['arcane', '奥术'], ['physical', '物理'], ['nature', '自然'], ['water', '水流']
  ];
  var STATUSES = [
    ['none', '无'], ['burn', '灼烧(持续伤害)'], ['slow', '减速'], ['freeze', '冻结(定身)'],
    ['stun', '眩晕'], ['poison', '中毒(持续伤害)'], ['weaken', '易伤'], ['heal', '治疗自身'], ['shield', '护盾自身']
  ];
  var ATTACH = [
    ['projectile', '跟随投射物'], ['marble', '跟随弹珠'], ['launch', '发射瞬间'], ['impact', '命中瞬间'],
    ['wall', '撞墙瞬间'], ['wallFace', '贴合墙面(碰撞接触面)'], ['expire', '消失瞬间'], ['caster', '施法者身上'],
    ['enemy', '敌方弹珠身上'], ['marbleCenter', '弹珠圆心（居中挂载）'],
    ['path', '弹珠移动路径'],
    ['host', '跟随所属载体（连线自动识别）']
  ];
  /* path：弹珠移动路径。特效/粒子不跟随弹珠、也不固定在一处，而是「触发后」在「路径持续时长」内，
     每隔「路径触发间隔」在施法弹珠当前所在位置落下一个独立实例；弹珠移动时就会沿轨迹铺出一条
     由技能效果组成的拖尾（区别于「跟随弹珠」——那是始终贴着弹珠、不留下残影）。
     需配合同模块的 pathInterval / pathDuration 两个参数使用。 */
  /* host：特效按连线归属自动挂到「投射物 / 区域残留 / 光环」实体上。
     连线到区域残留时再显示「跟随投射物」会让人以为特效挂在弹体上，
     实际上运行时找不到投射物就会落空 —— 见 compile 的 fxByHostNode。 */
  /* marbleCenter：素材以自身 meta.origin 为锚点绘制，运行时会反向补偿 origin，
     让特效包围盒中心真正落在弹珠圆心上（普通「跟随弹珠」不做这层补偿）。 */
  /* 多个敌人时的选靶规则：仅在挂载位置=敌方弹珠身上 时生效 */
  var ENEMY_PICK = [
    ['nearest', '距离施法者最近的敌人'], ['random', '随机一个敌人'], ['all', '全部敌人（各挂一份）']
  ];
  // 触发事件（类型化多端口）：对应参考编辑器的「命中结算/撞墙/射程耗尽/投射物结束」独立输出口
  var TRIGGERS = [
    ['onCast', '施放时'], ['onHit', '命中时'], ['onWall', '撞墙时'], ['onExpire', '消失时']
  ];
  var EVENT_KEYS = ['onCast', 'onHit', 'onWall', 'onExpire'];

  /* 技能充能：未填写时使用的默认秒数（技能级属性，与节点图无关） */
  var DEFAULT_CHARGE = 3;
  function chargeOf(skill) {
    var v = Number(skill && skill.charge);
    if (!isFinite(v) || v <= 0) return DEFAULT_CHARGE;
    return Math.max(0.2, Math.min(60, v));
  }
  /* ---- 墙面残留伤害规则：统一归到「伤害 · 结算」模块 ----
     两种互不排斥的伤害方式：
       aura    每秒对周围造成伤害（运行时每 0.5 秒结算半秒的量）
       contact 敌方弹珠触碰 / 进入该区域时受伤（可设重复触碰间隔）
     mode=auto 时按填了哪个数值自动决定；both 表示两种同时生效。 */
  var WALL_MODES = [
    ['auto', '自动（按填写的数值决定）'],
    ['none', '关闭墙面伤害（纯表现）'],
    ['aura', '每秒对周围造成伤害'],
    ['contact', '敌方弹珠触碰区域时受伤'],
    ['both', '两种同时生效']
  ];
  function normWall(p) {
    p = p || {};
    var dps = Math.max(0, Number(p.wallDps) || 0);
    var touch = Math.max(0, Number(p.wallTouchDamage) || 0);
    var dur = Math.max(0.5, Number(p.wallDuration) || 3);
    var radius = Math.max(0, Number(p.wallRadius) || 60);
    var interval = Math.max(0, Number(p.wallTouchInterval) || 0);
    var mode = p.wallDamageMode || 'auto';
    if (mode === 'auto') mode = (dps > 0 && touch > 0) ? 'both' : (dps > 0 ? 'aura' : (touch > 0 ? 'contact' : 'none'));
    if (mode === 'aura') touch = 0;
    else if (mode === 'contact') dps = 0;
    else if (mode === 'none') { dps = 0; touch = 0; }
    return {
      wallDamageMode: mode, wallDps: dps, wallTouchDamage: touch,
      wallDuration: dur, wallRadius: radius, wallTouchInterval: interval
    };
  }
  /** 汇总同一技能内所有 damage 节点的墙面残留规则。
   *  fxList 仅用于兼容旧存档（伤害字段曾挂在「贴合墙面」的像素特效节点上）。 */
  function wallHazardOf(damageList, fxList) {
    var out = { wallDamageMode: 'none', wallDps: 0, wallTouchDamage: 0, wallDuration: 0, wallRadius: 0, wallTouchInterval: 0 };
    var bits = 0;
    var list = (damageList || []).map(normWall);
    /* 旧 fx 字段只作为「完全没有 damage 墙面规则」时的兜底。
       后台不加载 config-loader.js（其存档由浏览器实时写回），源文件里 fx 与 damage
       双份共存时若一并累加，墙面伤害会翻倍 / 凭空多出一套每秒伤害。 */
    var hasDamageRule = (damageList || []).some(function (d) {
      return d && (d.wallDamageMode != null || d.wallDps != null || d.wallTouchDamage != null ||
                   d.wallDuration != null || d.wallRadius != null || d.wallTouchInterval != null);
    });
    if (!hasDamageRule) {
      (fxList || []).forEach(function (f) {
        if (f && f.attach === 'wallFace' && Number(f.wallDps) > 0) {
          list.push(normWall({ wallDamageMode: 'aura', wallDps: f.wallDps, wallDuration: f.wallDuration, wallRadius: f.wallRadius }));
        }
      });
    }
    list.forEach(function (w) {
      out.wallDps += w.wallDps;
      out.wallTouchDamage += w.wallTouchDamage;
      out.wallDuration = Math.max(out.wallDuration, w.wallDuration);
      out.wallRadius = Math.max(out.wallRadius, w.wallRadius);
      out.wallTouchInterval = Math.max(out.wallTouchInterval, w.wallTouchInterval);
      if (w.wallDps > 0 || w.wallDamageMode === 'aura') bits |= 1;
      if (w.wallTouchDamage > 0 || w.wallDamageMode === 'contact') bits |= 2;
    });
    if (!out.wallDuration) out.wallDuration = 3;
    if (!out.wallRadius) out.wallRadius = 60;
    out.wallDamageMode = bits === 3 ? 'both' : bits === 2 ? 'contact' : bits === 1 ? 'aura' : 'none';
    return out;
  }
  /** 模块伤害合计（属性面板展示）：每秒伤害 × 持续秒数 + 触碰伤害 × 理论可触发次数 */
  function wallDamageOf(cfg) {
    var w = normWall(cfg);
    var hits = w.wallTouchInterval > 0 ? Math.max(1, Math.floor(w.wallDuration / w.wallTouchInterval)) : 1;
    return w.wallDps * w.wallDuration + w.wallTouchDamage * hits;
  }

  var MODULES = {
    source: {
      label: '触发 · 来源', short: '来源', color: '#e8a95c', desc: '决定技能何时施放、施放几次、朝哪里打',
      fields: [
        sel('trigger', '触发时机', 'roundStart', [
          ['roundStart', '回合开始'], ['interval', '定时循环'], ['onCharge', '充能完成时'],
          ['onHit', '受到撞击时'], ['onWall', '弹珠撞墙时'], ['onLowHp', '生命低于 40%'], ['onCast', '施放其它技能时']
        ]),
        n('delay', '首次延迟(秒)', 0.35, 0, 8, 0.05),
        n('interval', '循环间隔(秒)', 2.2, 0.2, 12, 0.1, 'trigger=定时循环 时生效；实际节奏取「循环间隔」与「技能充能」的较大值。充能完成时 不依赖间隔，充能条一满即释放，循环往复'),
        n('maxCasts', '每回合最多施放', 0, 0, 30, 1, '0 = 不限次数'),
        sel('aim', '发射方向', 'atEnemy', [['atEnemy', '瞄准对手'], ['forward', '沿当前速度'], ['random', '随机方向'], ['mouse', '固定角度']]),
        n('angle', '固定角度(度)', 0, -180, 180, 1, 'aim=固定角度 时生效'),
        b('enabled', '启用', true)
      ]
    },
    /* 延迟·延时：纯路由节点，不是效果本身。接在任意模块之后，它下游直接 / 间接连着的所有模块
       都相对触发事件延后 seconds 秒才生效（特效延后播放、状态延后施加、护盾延后套上……）。
       同一模块若同时被多个延迟节点覆盖，取累计延迟的最大值。它是「模块与模块之间的延迟生效」开关，
       不写入任何数值、不产生任何表现，只改变下游的结算时机。 */
    delay: {
      label: '延迟 · 延时', short: '延迟', color: '#9aa6b8', desc: '纯路由节点：接在任意模块之后，让它下游所有模块相对触发事件延后「延迟(秒)」才生效。可以串联多个延迟做更长的延时；不写任何数值、不产生表现，只改变下游的结算时机',
      fields: [
        n('seconds', '延迟(秒)', 0.5, 0, 8, 0.05, '本模块下游直接 / 间接连着的所有模块，都延后这么多秒才生效（相对它自己的触发事件）。0 = 不延迟')
      ]
    },
    /* 目标 · 锁定：决定「这个技能作用在谁身上」。
       接在触发来源之后、其它模块之前；不接时保持旧行为（命中时打对手、施放时以对手为目标）。
       多敌人 / 队友按「挑选规则」排序后取前 N 个（N=1~4）。 */
    select: {
      label: '目标 · 锁定', short: '单体', color: '#c9a6ff',
      desc: '决定技能作用于谁：自身 / 单个敌人 / 多个敌人 / 队友。接在「触发 · 来源」后面，下游的伤害、状态、印记、位移、撞墙伤害都以这里选出的单位为目标；不接时按旧行为以对手为目标',
      fields: [
        sel('side', '选择对象', 'self', [
          ['self', '自身'], ['enemyOne', '单个敌人'], ['enemyMany', '多个敌人'],
          ['allyOne', '单个队友'], ['allyMany', '多个队友']
        ], '自身=只作用于施法者自己；敌人=对方阵营（当前 1v1 即对手，多敌人时按挑选规则取）；队友=同阵营其它单位'),
        sel('pick', '挑选规则', 'nearest', [
          ['nearest', '距离最近'], ['farthest', '距离最远'], ['random', '随机'],
          ['lowestHp', '血量最低'], ['highestHp', '血量最高']
        ], '单个对象按此规则挑选；多个对象按此规则排序后取前 N 个'),
        n('count', '数量', 1, 1, 4, 1, '仅「多个敌人 / 多个队友」生效：最多同时作用于几个单位')
      ]
    },
    element: {
      label: '元素 · 属性', short: '元素', color: '#5ac8fa', desc: '可挂多个：火 + 冰 = 霜火，同时拥有两种伤害与状态',
      multi: true,
      fields: [
        sel('triggerEvent', '触发事件', 'onHit', TRIGGERS),
        sel('element', '元素', 'fire', ELEMENTS),
        c('color', '特效主色', '#ff7a30'),
        n('damage', '固定伤害', 14, 0, 300, 1),
        n('damagePct', '目标最大生命伤害(%)', 0, 0, 40, 0.5, '按百分比扣血，填 3 表示 3%'),
        sel('status', '附加状态', 'none', STATUSES),
        n('statusPower', '状态强度', 0.3, 0, 1, 0.05),
        n('statusDuration', '状态时长(秒)', 2.5, 0.2, 10, 0.1),
        n('critBonus', '额外暴击率', 0, 0, 1, 0.02),
        n('armorPen', '护甲穿透', 0, 0, 1, 0.02),
        b('enabled', '启用', true)
      ]
    },
    damage: {
      label: '伤害 · 结算', short: '伤害', color: '#ef7c8e',
      desc: '所有伤害规则统一在此：先选「伤害对象」决定打敌方还是自伤，再选「触发事件」何时结算；触发事件=命中时 时，「命中判定」决定认哪种命中（弹珠碰撞 / 投射物命中 / 范围命中 / 必中直击）。撞墙后的残留区域伤害与「持续伤害(跟随)」也在这里配——触发后在跟随点留下一片持续掉血区（与特效模块解耦，特效只负责表现）',
      fields: [
        sel('affect', '伤害目标', 'enemy', [['enemy', '敌方'], ['self', '自身（反噬 / 自伤）'], ['both', '敌方 + 自身']],
          '敌方=命中谁就伤害谁；自身=结算时反过来扣自己的血（反噬 / 献祭类技能）；双方=两边都吃这份伤害。自身的伤害不吃护盾以外的命中附加（印记 / 暴击按自身面板算）'),
        sel('triggerEvent', '触发事件', 'onHit', TRIGGERS,
          '何时结算这份伤害：施放时=技能一放就结算（目标由「目标 · 锁定」决定，没接锁定模块则默认对手）；命中时=要真的打中才结算；撞墙时=受击者被本技能击退后撞到墙面时结算（不是施法者自己撞墙）；消失时=投射物寿命结束'),
        sel('hitKind', '命中判定', 'auto', [
          ['auto', '自动（按技能形态）'], ['body', '弹珠碰撞'], ['projectile', '投射物命中'],
          ['area', '范围命中'], ['direct', '直接命中（必中）']
        ], '仅「触发事件 = 命中时」生效。自动 = 有投射物→投射物命中；有范围判定→范围命中；只有自身位移（冲锋 / 突进）→弹珠碰撞；都没有→必中直击。选了「弹珠碰撞」就绝不会隔空扣血——本体必须真的碰到对手（试放沙盘里两颗弹珠有碰撞物理，可以直接撞出来）'),
        n('base', '基础伤害', 0, 0, 300, 1),
        n('pctMaxHp', '基础最大生命伤害(%)', 0, 0, 40, 0.5),
        n('critChance', '暴击率加成', 0, 0, 1, 0.02),
        n('critMult', '暴击倍率加成', 0, 0, 4, 0.1),
        n('lifesteal', '吸血比例', 0, 0, 1, 0.02),
        n('armorPen', '护甲穿透', 0, 0, 1, 0.02),
        n('knockback', '击退力度', 0, 0, 400, 5, '0 = 不击退；受击者沿「施法者→受击者」方向被推开，撞到墙 / 边界时结算「触发事件 = 撞墙时」的伤害'),
        b('ignoreShield', '无视护盾', false),
        b('ignoreDodge', '无视闪避', false),
        b('canCrit', '允许暴击', true),
        // 墙面残留伤害：撞墙接触面留下的区域，分为「每秒对周围造成伤害」和「敌方弹珠触碰区域时受伤」
        sel('wallDamageMode', '墙面残留 · 伤害方式', 'auto', WALL_MODES,
          '撞墙后在接触面留下伤害区；两种方式可同时填数值生效。区域位置由图里「贴合墙面」的像素特效显示，与触发事件无关'),
        n('wallDps', '墙面残留 · 每秒伤害', 0, 0, 80, 1, '方式=每秒 / 两种：每 0.5 秒对半径内敌方弹珠结算一次；0 = 不启用'),
        n('wallTouchDamage', '墙面残留 · 触碰伤害', 0, 0, 300, 1, '方式=触碰 / 两种：敌方弹珠进入该区域时立即受伤；0 = 不启用'),
        n('wallTouchInterval', '墙面残留 · 触碰间隔(秒)', 0.8, 0, 5, 0.1, '停留在区域内时重复受伤的最小间隔；0 = 只在进入瞬间结算一次'),
        n('wallDuration', '墙面残留 · 持续(秒)', 3, 0.5, 12, 0.5, '墙面效果与两种伤害一起停留的时长'),
        n('wallRadius', '墙面残留 · 伤害半径', 60, 0, 300, 5, '以墙面接触点为圆心，进入该半径的敌方弹珠才会受伤'),
        // 持续伤害(跟随)：触发后留下一片跟随目标的持续掉血区，伤害数值统一在此结算（与特效解耦）
        b('dotEnable', '持续伤害(跟随)', false, '勾选 = 触发后在「跟随点」留下一片持续伤害区，按「结算间隔」反复结算伤害；圆心跟随指定目标移动（与特效的「跟随弹珠 / 敌方弹珠」一致），伤害数值在本模块统一结算，不再写进特效模块'),
        n('dotDps', '持续伤害(每秒)', 8, 0, 120, 1, '仅在勾选「持续伤害(跟随)」时生效；单次结算 = 每秒伤害 × 结算间隔'),
        n('dotRadius', '持续伤害半径', 70, 0, 400, 5, '以跟随点（施法者 / 命中目标 / 落点）为圆心'),
        n('dotInterval', '结算间隔(秒)', 0.5, 0.1, 2, 0.1, '每隔多久结算一次，与「区域 · 残留」的 0.5 秒节奏一致'),
        sel('dotFollow', '跟随方式', 'caster', [
          ['caster', '跟随施法者'], ['target', '跟随命中目标'], ['impact', '固定落点']
        ], '伤害区圆心跟随谁移动：跟随施法者=和特效「跟随弹珠」一致（自身弹珠当圆心）；跟随命中目标=跟着被打中的弹珠走；固定落点=停留在命中 / 触发位置'),
        n('dotDuration', '持续(秒)', 6, 0.5, 20, 0.5, '这片持续伤害存在多久；到期自动消失（与特效「存在时长」无关，各自独立）')
      ]
    },
    range: {
      label: '范围判定', short: '范围', color: '#ffd479',
      desc: '定义这个载体「打到哪里」：接在投射物 / 光环 / 指向性 / 区域后面，下游模块只对判定区域内的目标生效。不接时按「投递形态」自带的距离参数自动生成判定区域',
      fields: [
        sel('shape', '判定形状', 'circle', [
          ['circle', '圆形'], ['cone', '扇形'], ['line', '射线带'], ['ring', '环形']
        ], '圆形：以判定圆心为基准的半径范围；扇形：沿发射方向按角度张开的扇区；射线带：沿发射方向的长条；环形：外圈以内、内圈以外'),
        n('radius', '判定半径', 0, 0, 600, 5, '0 = 继承投递形态自带的距离（近战距离 / 区域半径）；填数值则覆盖它'),
        n('innerRadius', '内圈半径', 0, 0, 500, 5, '判定形状=环形 时生效'),
        n('angleDeg', '扇形角度', 90, 5, 360, 5, '判定形状=扇形 时生效；360 = 整圆'),
        n('length', '射线长度', 600, 50, 2000, 10, '判定形状=射线带 时生效'),
        n('width', '射线宽度', 20, 2, 200, 1, '判定形状=射线带 时生效'),
        n('castRange', '落点距离', 0, 0, 2000, 10, '区域作用：从施法者沿瞄准方向飞多远落地；0 = 用「最大飞行距离」，两者都没有则 260'),
        sel('origin', '判定圆心', 'caster', [
          ['caster', '我方（施法者）'], ['opponent', '敌方（对手）'], ['impact', '命中 / 落点'], ['auto', '按投递形态自动']
        ], '我方=围绕自己的弹珠画范围（近身自走 AoE 最常用）；敌方=围绕对手的弹珠画范围（在敌人身上炸开）；命中/落点=投射物实际命中点；射线带恒以施法者为起点'),
        n('maxTargets', '敌人数量', 0, 0, 20, 1, '0 = 范围内所有敌人；大于 0 时先按「挑选规则」排序，再取前 N 个'),
        sel('pick', '挑选规则', 'nearest', [
          ['nearest', '距离最近'], ['farthest', '距离最远'], ['lowestHp', '血量最低'], ['highestHp', '血量最高']
        ], '目标上限 > 0 时生效：决定优先选哪几个敌人（先排序再截断）'),
        b('includeSelf', '也作用于自身', false, '勾选=判定区域内的自身 / 友方也参与结算（一般用于增益型技能）')
      ]
    },
    projectile: {
      label: '投射物', short: '投射物', color: '#8ad6a0', desc: '数量 / 速度 / 射程 / 大小 / 外观（PNG 素材）/ 穿透 / 追踪 / 绑定施法者。被运动器「投射物绑定」时运动器只接管「飞行方向」，这里的飞行速度 / 加速度 / 最大飞行距离 / 追踪强度依然照常结算。碰什么、撞墙后继续走还是反弹，属于碰撞行为，在运动器的「碰撞处理」里配置（没有绑定运动器时默认碰撞单位与障碍物、撞墙即消失）',
      fields: [
        t('name', '命名（自定义名称）', '', '给这批投射物起个名字，方便运动器「投射物绑定」按名称精确锁定要绑定的创建目标；留空则走图结构自动识别（运动器前面直接连着的投射物）'),
        n('count', '投射物数量', 1, 1, 24, 1),
        n('spread', '扇形角度', 0, 0, 360, 1),
        n('speed', '飞行速度', 300, 0, 1200, 5, '0 = 不自行飞行（配合「绑定施法者单位」可做贴身浮游弹）；被运动器接管时，环绕类轨迹（环绕自身 / 环绕对手）的环绕线速度由它决定'),
        n('accel', '加速度', 0, -600, 600, 5, '每秒增加的速度；被运动器接管时同样生效（在运动器给的方向上持续加速）'),
        n('range', '最大飞行距离', 0, 0, 3000, 20, '0 = 不限制；被运动器接管时按实际飞行轨迹累计'),
        n('size', '投射物半径', 9, 2, 48, 1),
        img('image', '投射物图片', '', '上传 PNG 素材替换默认手绘弹体（≤ 200 KB，建议透明背景，最长边不超过 1024px）。图片按最长边等比缩放到「半径 × 2」的方框内居中，默认朝向 = 发射方向并随「自转速度」转动，命中判定仍按半径计算；留空 = 按元素颜色画圆'),
        b('noRotFollow', '贴图不跟随发射方向旋转', false, '勾选 = 贴图保持素材原始朝向，不再随发射方向转动（素材画的是朝上的箭头时，打向右侧不会再偏 90°）；「自转速度」仍会正常叠加，填 0 就是完全固定。取消（默认）= 贴图朝向跟着发射方向走。只影响贴图外观，命中判定 / 碰撞 / 运动轨迹都不受影响；没上传图片时看不出效果'),
        n('pierce', '穿透目标次数', 0, 0, 12, 1, '命中「单位（弹珠）」后还能继续穿透几个目标；0 = 命中第一个即消失。投射物撞不撞单位、撞不撞墙，在运动器的「碰撞处理 · 碰撞对象」里配置'),
        n('homing', '追踪强度', 0, 0, 1, 0.02, '0 = 直线，1 = 强追踪；被运动器接管时也会把方向往敌方拉，与「环绕」同时开会互相拉扯，建议只开一个'),
        n('gravity', '重力', 0, -600, 600, 5),
        n('lifetime', '存活时间(秒)', 4, 0, 60, 0.1, '到时自动消失；0 = 不自动消失（一直活到命中 / 撞墙 / 施法者死亡）'),
        n('gap', '多发间隔(秒)', 0, 0, 1, 0.01, '0 = 全部同时发射（默认）；填 N = 每隔 N 秒发下一发，第 1 发立即射出，之后依次延迟。想让 5 发排成一串就填 0.2～0.5；间隔期间弹体停在出生点跟随施法者，不移动、不结算命中'),
        n('spawnOffset', '出生点偏移', 28, 0, 120, 1),
        b('bindCaster', '绑定施法者单位', false, '勾选 = 这批投射物归属于施法者：施法者死亡时弹体一并消失，默认随施法者一起位移（下一项可关）；配合运动器「环绕自身 + 环绕时间 0(无限)」可做绕身卫星弹 / 护体弹幕'),
        b('followCaster', '跟随施法者移动', true, '仅「绑定施法者单位」生效：勾选 = 每帧跟随施法者的位移（跑动 / 被击退 / 瞬移都跟得住，运动器算的环绕轨迹也随之整体平移）；取消 = 只在世界坐标里按自己的轨迹飞，施法者移动不影响它，仅在施法者死亡时消失'),
        n('jitter', '随机角度抖动', 0, 0, 180, 1),
        n('spin', '自转速度(度/秒)', 0, -720, 720, 5),
        b('trail', '拖尾', true, '勾选 = 沿飞行轨迹画一条尾迹（长度 / 宽度 / 不透明度见下面三项）；取消 = 完全不画。注意：PNG 素材画面里自带的拖影属于图片内容，本开关管不到，想彻底去掉只能换素材或调小「投射物半径」'),
        n('trailLen', '拖尾长度(秒)', 0.16, 0.02, 0.8, 0.02, '尾巴保留最近多少秒的轨迹：越大尾巴越长。与飞行速度叠加——飞得快的弹尾巴天生更长。仅「拖尾」勾选时生效'),
        n('trailWidth', '拖尾宽度(%)', 100, 10, 300, 10, '相对投射物半径的百分比：100 = 与半径同宽，50 = 一半宽，200 = 两倍宽。仅「拖尾」勾选时生效'),
        n('trailAlpha', '拖尾不透明度(%)', 32, 0, 100, 1, '0 = 完全透明（等于关掉尾巴），100 = 不透明。默认 32 是淡尾迹，想更醒目就调高。仅「拖尾」勾选时生效'),
        b('fadeOut', '消失前淡出', true),
        sel('delivery', '投递形态', 'projectile', [
          ['projectile', '投射物'], ['aoe', '区域作用'], ['melee', '近战判定'], ['ray', '射线判定'], ['summon', '召唤分身']
        ], '决定技能如何送达目标：投射物(默认) / 区域作用(落点炸开) / 近战 / 射线 hitscan / 召唤友方分身'),
        n('areaRadius', '区域半径', 80, 0, 400, 5, 'delivery=区域作用 时生效：落点为圆心的命中判定半径'),
        n('castRange', '区域落点距离', 0, 0, 2000, 10, 'delivery=区域作用 时生效：从施法者沿瞄准方向飞多远落地；0 = 用「最大飞行距离」，都没有则 260'),
        n('meleeRange', '近战距离', 60, 10, 300, 5, 'delivery=近战判定 时生效：以施法者为圆心的命中判定半径'),
        n('rayRange', '射线长度', 600, 50, 2000, 10, 'delivery=射线判定 时生效'),
        n('rayWidth', '射线宽度', 20, 2, 200, 1, 'delivery=射线判定 时生效'),
        n('summonDur', '分身存活(秒)', 6, 1, 20, 0.5, 'delivery=召唤分身 时生效')
      ]
    },
    targeted: {
      label: '指向性 · 锁定', short: '指向', color: '#6fa8ff',
      desc: '不发射投射物，直接锁定一个目标结算：立即命中 / 延迟命中 / 持续引导。命中后照常走「命中时」整条链路（伤害 / 状态 / 标记 / 特效 / 区域 / 回响），因此与投射物模块二选一；两者同时接入时以指向性为准',
      fields: [
        sel('targetSide', '作用对象', 'enemy', [['enemy', '敌方目标'], ['self', '自身（增益 / 自我强化）']],
          '敌方：锁定对手并结算「命中时」的伤害与效果；自身：不结算伤害，只把状态 / 护盾 / 增益 / 特效作用在自己身上'),
        sel('applyMode', '生效方式', 'instant', [
          ['instant', '立即命中'], ['delay', '延迟命中'], ['channel', '持续引导']
        ], '立即：施放瞬间结算一次；延迟：等待「前摇」秒后结算一次；持续引导：前摇结束后按间隔反复结算，直到引导时长走完'),
        n('delay', '前摇(秒)', 0, 0, 6, 0.1, '延迟命中：等待多久后命中；持续引导：首次结算前的引导前摇（0 = 立即进入引导）'),
        n('channelDuration', '引导时长(秒)', 2, 0.2, 12, 0.2, '仅「持续引导」生效：从首次结算起持续多久'),
        n('channelInterval', '引导间隔(秒)', 0.5, 0.1, 3, 0.1, '仅「持续引导」生效：每隔多久结算一次（每次结算都算一次完整的命中）'),
        b('tickOnStart', '引导首次立即结算', true, '勾选=前摇结束的瞬间先结算一次，再按间隔继续；取消=前摇结束后等一个间隔才首次结算'),
        n('maxRange', '最大锁定距离', 0, 0, 2000, 20, '0 = 不限距离；超出距离时本次不生效（仍然播放施放时的特效），用于做「近身指向技」'),
        b('interruptOnDeath', '目标死亡后中断', true, '引导期间目标或施法者死亡即中断，不再结算剩余段数')
      ]
    },
    status: {
      label: '事件状态', short: '状态', color: '#f0925a', desc: '在指定事件触发时给目标或自身施加状态（击退/冻结/护盾…），对应参考的「技能事件」扇出',
      fields: [
        sel('triggerEvent', '触发事件', 'onHit', TRIGGERS),
        sel('status', '状态', 'none', STATUSES),
        n('statusPower', '状态强度', 0.3, 0, 1, 0.05),
        n('statusDuration', '状态时长(秒)', 2.5, 0.2, 10, 0.1),
        t('statusTag', '状态图标标签', '', '可选：填一个标签，对局双方卡片的 BUFF/DEBUFF 栏会显示后台「状态图标」里同标签的自定义条目（名称、颜色、图标都在后台配置）'),
        b('self', '作用于自身', false, '勾选=给自己加状态（护盾/治疗）；否则给对手'),
        b('statusPersistent', '持续生效', false, '勾选=在「状态时长」内按「持续间隔」反复重新施加该状态，使其持续覆盖（如减速全程不断、治疗按间隔多次触发）。不勾选=只在触发瞬间施加一次'),
        n('statusInterval', '持续间隔(秒)', 0.5, 0.05, 5, 0.05, '仅「持续生效」勾选时生效：每隔多久重新施加一次该状态')
      ]
    },
    fx: {
      label: '像素特效', short: '特效', color: '#b79cf0',
      desc: '从 pixelfx 244 个开源特效中选择，可改色/尺寸/帧率/光效；只负责表现，伤害数值一律在「伤害·结算」模块配置（含「持续伤害(跟随)」），特效模块不再写任何伤害',
      multi: true,
      fields: [
        sel('triggerEvent', '触发事件', 'onHit', TRIGGERS),
        t('name', '命名（自定义名称）', '', '给这个魔法效果起个名字，便于在模块列表 / 运动器绑定目标里辨认'),
        { key: 'effect', label: '特效', type: 'effect', def: 'fire/fireball', hint: '点击右侧特效库选择' },
        sel('attach', '挂载位置', 'projectile', ATTACH, '贴合墙面：生成在球与墙体的接触面上、沿墙面朝向，适合「墙面残留」类效果；该区域的伤害参数在「伤害·结算」模块里设置。敌方弹珠身上：特效挂在敌方弹珠上随之移动，多个敌人时的选靶规则见下一项'),
        sel('enemyPick', '敌人选择', 'nearest', ENEMY_PICK, '挂载位置=敌方弹珠身上 时生效：最近/随机只挂一个，全部则每名敌人各挂一份'),
        n('pathInterval', '路径触发间隔(秒)', 0.15, 0.02, 2, 0.01, '仅「挂载位置=弹珠移动路径」时生效：每隔这么久在弹珠当前所在位置落下一个特效，弹珠移动时就会沿运动轨迹留下一串等时间间隔的特效'),
        n('pathDuration', '路径持续时长(秒)', 2, 0.1, 20, 0.1, '仅「挂载位置=弹珠移动路径」时生效：触发后持续这么久沿路径落特效；建议同时设置本模块的「存在时长」让每个落点特效短暂淡出，形成干净拖尾而非长时间残留'),
        n('scale', '尺寸倍率', 1, 0.1, 8, 0.05),
        n('fps', '播放帧率倍率', 1, 0.1, 4, 0.05, '相对特效原始帧率'),
        n('clipStart', '动画起始(秒)', 0, 0, 30, 0.1, '相对素材自身动画时间轴：填 3 = 跳过前 3 秒，直接从素材第 3 秒的画面开始播。配合「动画结束」可只播中间一段（例如 3→6 秒）。0 = 从第一帧开始；属性面板会显示当前素材一轮时长'),
        n('clipEnd', '动画结束(秒)', 0, 0, 30, 0.1, '播到素材第几秒为止；0 = 播到素材末尾（一轮时长由所选特效决定）。勾选「循环播放」时在「动画起始 → 动画结束」之间循环，而不是每次回到第一帧'),
        n('alpha', '不透明度', 1, 0, 1, 0.05),
        n('light', '发光强度', 1, 0, 3, 0.05),
        n('rotation', '旋转(度)', 0, -180, 180, 1),
        n('offsetX', '横向偏移', 0, -200, 200, 1),
        n('offsetY', '纵向偏移', 0, -200, 200, 1),
        b('loop', '循环播放', true, '仅在「存在时长 = 0」时生效：勾选 = 一轮播完立刻回到第一帧重播；取消 = 只播一次，播完就消失。填了存在时长时，播完一轮后的行为由下面「动画播完后」决定，本项不再让动画整轮重播'),
        n('life', '存在时长(秒)', 0, 0, 20, 0.5, '填了数值 = 这份特效一定存在这么久：动画播完一轮（或「动画起始→结束」区间）后，按下一项「动画播完后」保持画面直到时长结束，不会提前消失。0 = 自动：挂在敌方弹珠身上且同组有「标记·印记」时，这一份特效的寿命就等于印记的持续秒数（到点自己消失）；没有印记时兜底 4 秒后回收；不跟随实体的瞬时机效兜底 3.2 秒。填数值时到点强制销毁，优先于以上所有兜底'),
        sel('tailMode', '动画播完后', 'freeze', [
          ['freeze', '定格最后一帧'], ['loop', '循环最后 0.1 秒'], ['restart', '整轮从头重播']
        ], '仅在填了「存在时长」时生效：动画比存在时长短时如何撑满剩余时间。定格 = 停在最后一帧不动（默认）；循环最后 0.1 秒 = 反复播放末尾一小段，画面有轻微变化；整轮重播 = 旧的「自动循环补满」行为'),
        b('stackReplace', '同类特效覆盖', true, '勾选=同一目标上重复触发时先销毁旧实例、只保留最新一份；取消=每次触发都新留一份。注：挂在敌方身上且同组有「标记·印记」时始终只保留一份（一份印记配一份表现）'),
        b('additive', '叠加发光', false),
        b('flipX', '水平镜像', false),
        b('matchRotation', '跟随飞行方向', true, '勾选 = 角度跟随挂载载体的转向 / 飞行方向；取消 = 角度固定为下面的「旋转(度)」。注：本项只决定“怎么算朝向”，是否还要跟着挂载载体一起转由下一项控制'),
        b('noRotFollow', '效果不跟随挂载位置旋转', false, '勾选 = 特效仍跟随弹珠 / 施法者 / 敌方（或投射物）移动，但角度冻结在释放时的朝向上，不再跟着挂载体的转向或飞行方向转动；取消（默认）= 角度跟着挂载体一起转。位置跟随不受影响，特效始终贴着挂载点'),
        { key: 'fxOptions', label: '特效专属参数', type: 'fxoptions', def: {}, hint: '由所选特效自动生成：调色板 / 种子 / 尺寸等' }
      ]
    },
    particles: {
      label: '粒子', short: '粒子', color: '#f0c874', desc: '叠加在特效之上的可编辑粒子发射器',
      multi: true,
      fields: [
        sel('triggerEvent', '触发事件', 'onHit', TRIGGERS),
        n('count', '粒子数量', 14, 0, 200, 1),
        sel('shape', '形状', 'spark', [['spark', '火花'], ['square', '方块'], ['circle', '圆点'], ['star', '星形'], ['ring', '圆环']]),
        n('size', '粒子大小', 3, 0.5, 24, 0.5),
        n('sizeVar', '大小随机', 1.5, 0, 12, 0.5),
        n('speed', '初速度', 120, 0, 600, 5),
        n('speedVar', '速度随机', 60, 0, 400, 5),
        n('spread', '散射角度', 360, 0, 360, 5),
        n('life', '存活时间(秒)', 0.6, 0.1, 5, 0.05),
        n('lifeVar', '存活随机', 0.25, 0, 3, 0.05),
        n('gravity', '重力', 0, -600, 600, 5),
        n('drag', '阻力', 0.9, 0, 1, 0.01),
        n('emitRate', '持续发射(个/秒)', 0, 0, 120, 1, '0 = 只在触发瞬间发射一次'),
        sel('attach', '挂载位置', 'impact', ATTACH, '敌方弹珠身上：粒子从敌方弹珠身上持续喷发，多个敌人时的选靶规则见下一项'),
        sel('enemyPick', '敌人选择', 'nearest', ENEMY_PICK, '挂载位置=敌方弹珠身上 时生效：最近/随机只挂一个，全部则每名敌人各挂一份'),
        n('pathInterval', '路径触发间隔(秒)', 0.15, 0.02, 2, 0.01, '仅「挂载位置=弹珠移动路径」时生效：每隔这么久在弹珠当前所在位置喷发一次粒子，弹珠移动时就会沿运动轨迹留下一串等时间间隔的粒子'),
        n('pathDuration', '路径持续时长(秒)', 2, 0.1, 20, 0.1, '仅「挂载位置=弹珠移动路径」时生效：触发后持续这么久沿路径喷发粒子'),
        c('color', '粒子颜色', '#ffd76a'),
        c('color2', '渐变色', '#ff5a2a'),
        n('spin', '自旋', 0, -720, 720, 5),
        b('fade', '渐隐', true),
        b('additive', '叠加发光', true),
        b('enabled', '启用', true)
      ]
    },
    impact: {
      label: '命中 · 爆发', short: '命中', color: '#f0925a', desc: '命中后的范围伤害、连锁、击退、震屏与状态施加',
      fields: [
        sel('triggerEvent', '触发事件', 'onHit', TRIGGERS),
        n('aoeRadius', '爆炸半径', 0, 0, 400, 5),
        n('aoePct', '范围伤害比例', 0.5, 0, 3, 0.05, '相对本次命中伤害'),
        n('knockback', '击退力度', 0, 0, 600, 5),
        n('shake', '震屏强度', 0.15, 0, 1, 0.05),
        n('hitStop', '命中定格(毫秒)', 0, 0, 250, 5),
        n('chainCount', '连锁目标数', 0, 0, 8, 1),
        n('chainRange', '连锁范围', 260, 0, 1000, 10),
        n('chainFalloff', '连锁衰减', 0.7, 0, 1, 0.05),
        b('explodeOnWall', '撞墙也爆炸', false),
        b('explodeOnExpire', '消失时爆炸', false),
        b('applyStatus', '施加元素状态', true)
      ]
    },
    stats: {
      label: '结算 · 属性', short: '属性', color: '#7fa8e8', desc: '被动属性（写入技能原有 mods，与旧版技能完全兼容）',
      fields: [
        n('maxHp', '生命', 0, -100, 200, 1), n('power', '伤害倍率', 0, -1, 3, 0.01),
        n('speed', '速度', 0, -1, 3, 0.01), n('mass', '质量', 0, -1, 3, 0.01),
        n('crit', '暴击率', 0, -1, 2, 0.01), n('critMult', '暴击倍率', 0, -1, 4, 0.05),
        n('armor', '护甲', 0, -1, 1, 0.01), n('dodge', '闪避', 0, -1, 1, 0.01),
        n('regen', '每秒回复', 0, -0.1, 0.2, 0.001), n('shield', '初始护盾', 0, -1, 2, 0.01),
        n('thorns', '荆棘反伤', 0, -1, 2, 0.01), n('lifesteal', '吸血', 0, -1, 2, 0.01),
        n('firstStrike', '先手加成', 0, -1, 3, 0.01), n('momentum', '动量加成', 0, -1, 3, 0.01),
        n('combo', '连击加成', 0, -1, 1, 0.01), n('execute', '斩杀加成', 0, -1, 3, 0.01),
        n('slow', '减速', 0, -1, 1, 0.01), n('dot', '持续伤害', 0, -0.2, 0.3, 0.001),
        n('knock', '击退', 0, -1, 3, 0.01)
      ]
    },
    /* ---- 以下为扩充模块：位移 / 标记 / 护盾 / 分裂 / 区域 / 回响 ---- */
    motion: {
      label: '运动器 · 位移', short: '运动器', color: '#7de0c0',
      desc: '给目标弹珠挂一个运动器：触发瞬间先按「方向来源」确定一次面向，再让弹珠沿「运动轨迹」在这条面向上移动，按速度曲线在持续时间内走完位移距离，到期交还控制权。这是底层能力，可挂在任意触发事件上、作用于任意弹珠。环绕类轨迹（环绕对手 / 环绕自身）走匀速，环绕时长由「环绕时间」单独决定（0 = 无限）。作用于「投射物绑定」时，运动器只提供方向，速度 / 位移积分 / 飞行距离按投射物模块的数值结算；碰单位 / 障碍物 / 其他弹幕、撞墙后继续走还是反弹，统一在本模块的「碰撞处理」里配置',
      fields: [
        sel('triggerEvent', '触发事件', 'onCast', TRIGGERS),
        sel('scope', '作用目标', 'self', [
          ['self', '自身弹珠'], ['opponent', '对手弹珠'], ['both', '双方弹珠'],
          ['projectile', '投射物绑定（挂在创建的投射物上）']
        ], '运动器挂在哪颗弹珠上；「双方」时各自以自己的对手为方向参照；「投射物绑定」=识别本技能创建的投射物并把运动器挂在它身上——只接管它的飞行方向，速度 / 飞行距离仍按投射物模块的数值结算，碰撞对象与撞墙后的处理由本模块「碰撞处理」决定（位移距离=0 时只应用碰撞规则，不推动弹体）'),
        t('bindTarget', '绑定投射物名称', '', '仅「作用目标=投射物绑定」时生效：填写投射物模块里的「命名」可精确锁定；留空=自动识别运动器前面直接相连的投射物节点'),
        sel('track', '运动轨迹', 'line', [
          ['line', '直线'], ['arc', '弧线'], ['orbit', '环绕对手'], ['orbitSelf', '环绕自身'], ['homing', '追踪对手'], ['instant', '瞬移（瞬时生效）']
        ], '直线严格沿面向；弧线从面向开始逐渐偏转；环绕对手 / 追踪对手参照敌方弹珠；环绕自身以「自身弹珠（施法者）」为圆心——配合「投射物绑定」可做弹幕绕身，配合「对手弹珠」可让敌人绕你转；只有「瞬移」是一次性改坐标。所有轨迹都不会在运动中重新采样方向'),
        sel('dirFrom', '方向来源', 'toTarget', [
          ['toTarget', '朝向对手'], ['awayTarget', '背向对手'], ['velocity', '沿当前速度'],
          ['fixed', '固定角度'], ['perp', '对手连线垂直'], ['wallNormal', '墙面法线']
        ], '技能先面向这个方向（只在触发瞬间采样一次），之后严格按「运动轨迹」移动，不会跟着敌方弹珠转向；墙面法线仅在「撞墙时」触发且有接触面时生效，否则回退为朝向对手'),
        n('angle', '固定角度(°)', 0, -180, 180, 5, '仅方向来源 = 固定角度时生效；0° 向右、90° 向下'),
        n('arcDeg', '轨迹弯曲(°)', 60, -180, 180, 5, '弧线：从面向开始逐渐偏转的总角度（起步即朝面向）；环绕对手 / 环绕自身：正值顺时针、负值逆时针'),
        sel('ease', '速度曲线', 'easeIn', [
          ['linear', '匀速'], ['easeIn', '加速（越冲越快）'], ['easeOut', '减速（起步最快）'], ['easeInOut', '先加速后减速']
        ], '无论选哪条曲线，持续时间内走完的总距离都等于「位移距离」'),
        n('distance', '位移距离', 120, 0, 600, 10, '运动器持续期间沿轨迹累计推进的总距离；0 = 只计时并给冲量，不接管移动'),
        n('duration', '持续(秒)', 0.35, 0.05, 2, 0.05, '走完这段距离所用的时间；越短越像一次冲刺。环绕类轨迹用它折算线速度（位移距离 ÷ 持续），但「投射物绑定」时优先取投射物的「飞行速度」（为 0 才回退到这里）'),
        n('orbitTime', '环绕时间(秒)', 0, 0, 20, 0.5, '仅「环绕对手 / 环绕自身」生效：环绕多久后交还控制权；0 = 无限（一直绕到投射物消失 / 撞墙 / 命中才结束）。环绕期间全程匀速——「投射物绑定」时线速度 = 投射物的飞行速度（为 0 才用 位移距离 ÷ 持续），超过「持续」也继续绕，不会衰减停下'),
        n('impulse', '附加冲量', 0, 0, 600, 10, '运动器结束时额外获得的速度，可与结束速度叠加'),
        sel('endSpeed', '结束后速度', 'keep', [
          ['keep', '保留冲刺末速'], ['zero', '归零'], ['restore', '恢复施放前速率']
        ], '勾选「保持面向对手」时，「恢复施放前速率」只还原速度大小，方向继续沿用面向，冲刺结束不会拐回发射方向'),
        sel('stackMode', '叠加方式', 'replace', [
          ['replace', '替换同目标已有运动器'], ['add', '叠加并存'], ['ignore', '已有则忽略']
        ]),
        b('faceTarget', '保持面向对手', true, '勾选=附加冲量沿用采样瞬间的面向，且结束时不会把速度方向拐回施放前；取消=冲量沿用轨迹末方向、完全恢复施放前速度矢量。两者都不再读取对手的实时位置'),
        sel('collideTarget', '碰撞对象', 'all', [
          ['all', '单位（弹珠）+ 障碍物（墙）'], ['unit', '仅单位（弹珠）'],
          ['wall', '仅障碍物（墙）'], ['none', '不参与碰撞（纯表现）']
        ], '仅「作用目标=投射物绑定」生效：决定投射物会与哪几类碰撞体发生碰撞。选「仅障碍物」=穿过敌方弹珠不结算命中、不消耗穿透次数；选「仅单位」=无视场地边界与障碍墙，直接穿墙飞出场地（靠最大飞行距离 / 存在时长回收）。区域、陷阱、可破坏物等其他类型当前版本尚未参与投射物碰撞判定；弹幕互撞由下一项「碰撞投射物」单独控制'),
        sel('hitProjectile', '碰撞投射物', 'none', [
          ['none', '不碰撞投射物'], ['enemy', '仅敌方投射物'],
          ['ally', '仅己方投射物'], ['both', '己方 + 敌方投射物']
        ], '仅「作用目标=投射物绑定」生效：决定本弹幕会不会与其他弹幕相撞（与上面的单位 / 障碍物互相独立，可任意组合）。相撞瞬间两颗弹体一并销毁，并各自结算自己的「消失时」组；对方技能有没有配互撞不影响结果——只要有一方声明可撞，接触即生效。同一批发射出的多发弹（散弹 / 多发）互不碰撞，出生 0.12 秒内的弹也不参与互撞，避免分裂弹、贴身弹幕一出生就自我湮灭'),
        sel('wallAction', '触墙后行为', 'bounce', [
          ['bounce', '触墙反弹（交还运动器控制权）'], ['continue', '继续按运动器移动（穿墙）']
        ], '仅「碰撞对象」包含障碍物时生效。触墙反弹=按墙面法线弹开，运动器立刻交还控制权，之后弹体自由飞行；继续按运动器移动=墙体不再阻挡，弹体沿运动器当前方向继续走（环绕类继续绕圈），不消失、不累计反弹次数、不触发「撞墙时」事件'),
        b('dieOnWall', '撞墙后消失', true, '仅「作用目标=投射物绑定」且「触墙后行为=触墙反弹」时生效：勾选=撞到场地边界/障碍墙立刻消失，不再看反弹次数；取消=撞墙不消失，改由下一项「撞墙反弹次数」决定还能弹几下（0 = 无限反弹）。没有绑定运动器的投射物默认撞墙即消失'),
        n('wallBounce', '撞墙反弹次数', 0, 0, 12, 1, '仅「触墙后行为=触墙反弹」且「撞墙后消失」取消时生效：反弹 N 次后销毁，0 = 无限反弹；每次撞墙运动器都会交还控制权，之后弹体按反射方向自由飞行。绑定运动器但不接管位移（位移距离=0）时同样生效'),
        b('stopOnWall', '撞墙时结束', true, '只对「作用目标=弹珠」生效：勾选=碰到场地边界/障碍后立刻交还控制权并保留当前速度；取消=撞墙后运动器继续生效。「投射物绑定」时撞墙怎么处理由上面的「触墙后行为」决定，本项不参与')
      ]
    },
    mark: {
      label: '标记 · 印记', short: '印记', color: '#e8c85a',
      desc: '给目标挂上可叠加的印记：每层可按比例增伤 / 撕裂流血 / 破甲 / 迟滞，并可在满层或结束时引爆。层数越高效果越强，适合做「先叠印记、再引爆」的连段核心',
      fields: [
        sel('triggerEvent', '触发事件', 'onHit', TRIGGERS),
        n('stacks', '每次叠加层数', 1, 1, 5, 1, '每次触发向目标叠加多少层'),
        n('maxStacks', '层数上限', 5, 1, 20, 1),
        n('duration', '印记持续(秒)', 4, 1, 20, 0.5),
        sel('stackMode', '叠加方式', 'add', [
          ['add', '累加层数'], ['refresh', '只刷新时长'], ['max', '取较高层数'], ['replace', '覆盖（重置层数与效果）']
        ], '累加：每次触发继续往上叠；只刷新时长：层数不变、重新计时；取较高层数：层数取本次与已有的较大值；覆盖：丢弃旧印记，层数、每层效果与持续时间全部按本次重算（不会越叠越多）'),
        // ---- 每层效果（0 = 不启用，可同时生效）----
        n('damageAmp', '每层增伤(%)', 12, 0, 100, 1, '命中时按「层数 × 该值」放大本次伤害'),
        n('dotDps', '每层撕裂(每秒伤害)', 0, 0, 40, 0.5, '每秒对目标造成「层数 × 该值」的持续伤害'),
        n('armorBreak', '每层破甲(%)', 0, 0, 30, 1, '按层数削减目标护甲，等效放大所有来源的伤害'),
        n('slowPct', '每层迟滞(%)', 0, 0, 20, 1, '按层数降低目标移速（上限 70%）'),
        // ---- 引爆 ----
        sel('detonate', '引爆时机', 'none', [
          ['none', '不引爆'], ['onMax', '满层时引爆'], ['onExpire', '结束时引爆'], ['both', '满层或结束都引爆']
        ], '引爆会立刻结算一次「层数 × 每层引爆伤害」，并清空印记'),
        n('detonateDamage', '每层引爆伤害', 20, 0, 100, 1, '引爆时对目标造成「层数 × 该值」的伤害；0 = 只做表现'),
        n('detonateRadius', '引爆半径', 0, 0, 300, 10, '0 = 只打被标记的目标；>0 = 半径内的其他敌方也受溅射'),
        n('detonateSplash', '溅射比例(%)', 50, 0, 100, 5, '半径内其他敌方承受的引爆伤害比例'),
        // ---- 表现与消耗 ----
        b('consumeOnHit', '命中后消耗印记', false, '勾选=印记只吃到一次增伤就清空（适合「一发引爆」型）'),
        c('color', '印记颜色', '#e8c85a', '目标头顶层数点的颜色')
      ]
    },
    shield: {
      label: '护盾 · 屏障', short: '护盾', color: '#8ec8f0', desc: '给施法者自身套一层可吸收伤害的护盾，可附带反伤',
      fields: [
        sel('triggerEvent', '触发事件', 'onCast', TRIGGERS),
        n('amount', '护盾量(最大生命%)', 12, 1, 80, 1),
        n('duration', '护盾持续(秒)', 5, 1, 20, 0.5),
        n('thorns', '反伤比例', 0, 0, 1, 0.05)
      ]
    },
    split: {
      label: '分裂 · 溅射', short: '分裂', color: '#f0a8d0', desc: '投射物命中或消失时炸成多发小弹，形成二次覆盖',
      fields: [
        sel('triggerEvent', '触发事件', 'onHit', TRIGGERS),
        n('count', '分裂数量', 3, 2, 12, 1),
        n('spread', '散射角度', 360, 0, 360, 5),
        n('speedScale', '子弹性速度(%)', 70, 10, 200, 5),
        n('sizeScale', '子弹性大小(%)', 60, 10, 150, 5),
        n('damageScale', '子弹性伤害(%)', 50, 0, 150, 5),
        n('range', '子弹性射程', 260, 0, 900, 20, '0 = 不限制')
      ]
    },
    zone: {
      label: '区域 · 残留', short: '区域', color: '#8fd694', desc: '在命中点留下持续区域，按间隔对范围内敌人反复结算',
      fields: [
        sel('triggerEvent', '触发事件', 'onHit', TRIGGERS),
        n('radius', '区域半径', 70, 20, 300, 5),
        n('duration', '持续时间(秒)', 3, 0.5, 12, 0.5),
        n('dps', '每秒伤害', 6, 0, 80, 1),
        n('slowPct', '减速比例', 0, 0, 0.8, 0.05),
        c('color', '区域颜色', '#ff7a30'),
        b('followCaster', '跟随施法者', false, '勾选=区域挂在自身身上移动，否则固定在落点')
      ]
    },
    aura: {
      label: '光环 · 领域', short: '光环', color: '#b98cff',
      desc: '以自身为圆心持续展开领域：伤害型对范围内敌方按间隔结算伤害并施加减益；增益型对自身/友军持续施加增益。范围圈在实时试放里可见',
      fields: [
        sel('triggerEvent', '触发事件', 'onCast', TRIGGERS),
        sel('auraType', '光环类型', 'damage', [
          ['damage', '伤害型（作用于敌方）'], ['buff', '增益型（作用于自身/友军）']
        ], '伤害型：对半径内敌方持续造成伤害与减益；增益型：对半径内自身/友军持续施加增益'),
        n('radius', '范围半径', 90, 20, 400, 5, '以自身为圆心的作用半径；实时试放里会画出范围圈'),
        n('duration', '持续(秒)', 4, 0.5, 15, 0.5),
        n('tickInterval', '结算间隔(秒)', 0.5, 0.1, 2, 0.1, '每隔多少秒对范围内的目标结算一次'),
        // ---- 伤害型 ----
        n('dps', '每秒伤害', 8, 0, 120, 1, '光环类型=伤害型时生效'),
        sel('debuff', '减益状态', 'none', STATUSES, '光环类型=伤害型时生效：对范围内敌方施加的减益'),
        n('debuffPower', '减益强度', 0.3, 0, 1, 0.05, '减速 / 冻结 / 眩晕 / 易伤等按此强度换算'),
        n('debuffDuration', '减益时长(秒)', 2, 0.2, 10, 0.1),
        // ---- 增益型 ----
        sel('buff', '增益状态', 'none', STATUSES, '光环类型=增益型时生效：对自身/友军施加的增益（治疗 / 护盾 等）'),
        n('buffPower', '增益强度', 0.3, 0, 1, 0.05),
        n('buffDuration', '增益时长(秒)', 2, 0.2, 10, 0.1),
        c('color', '光环颜色', '#b98cff'),
        b('followCaster', '跟随施法者', true, '勾选=领域以自身为圆心随施法者移动；取消=固定在施放瞬间的位置')
      ]
    },
    echo: {
      label: '回响 · 连发', short: '回响', color: '#c8a0f0', desc: '触发后延迟若干次重放本组伤害与特效，做出连击节奏',
      fields: [
        sel('triggerEvent', '触发事件', 'onHit', TRIGGERS),
        n('times', '重复次数', 1, 1, 5, 1),
        n('delay', '间隔(秒)', 0.5, 0.15, 3, 0.05),
        n('powerScale', '威力(%)', 60, 10, 150, 5)
      ]
    }
  };

  // 下拉分组（仅影响后台「添加模块」的归类展示）
  var GROUPS = {
    source: '触发', select: '触发', projectile: '投递', targeted: '投递', motion: '投递', range: '投递',
    element: '效果', damage: '效果', impact: '效果', status: '效果', mark: '效果', shield: '效果', split: '效果', echo: '效果', aura: '效果', delay: '效果',
    fx: '表现', particles: '表现', zone: '表现',
    stats: '属性'
  };
  Object.keys(GROUPS).forEach(function (t) { if (MODULES[t]) MODULES[t].group = GROUPS[t]; });
  var GROUP_ORDER = ['触发', '投递', '效果', '表现', '属性'];

  /* 运动器字段较多，属性面板按语义分三段显示（section 仅影响后台排版） */
  var MOTION_SECTIONS = {
    scope: '作用对象与轨迹', bindTarget: '作用对象与轨迹', track: '作用对象与轨迹', dirFrom: '作用对象与轨迹',
    angle: '作用对象与轨迹', arcDeg: '作用对象与轨迹',
    ease: '速度与节奏', distance: '速度与节奏', duration: '速度与节奏', orbitTime: '速度与节奏', impulse: '速度与节奏',
    endSpeed: '收尾与叠加', stackMode: '收尾与叠加', faceTarget: '收尾与叠加',
    collideTarget: '碰撞处理', hitProjectile: '碰撞处理', wallAction: '碰撞处理', dieOnWall: '碰撞处理', wallBounce: '碰撞处理', stopOnWall: '碰撞处理'
  };
  MODULES.motion.fields.forEach(function (f) { if (MOTION_SECTIONS[f.key]) f.section = MOTION_SECTIONS[f.key]; });

  /* 印记字段较多，属性面板按「基础 / 每层效果 / 引爆 / 表现」四段显示 */
  var MARK_SECTIONS = {
    triggerEvent: '基础', stacks: '基础', maxStacks: '基础', duration: '基础', stackMode: '基础',
    damageAmp: '每层效果', dotDps: '每层效果', armorBreak: '每层效果', slowPct: '每层效果',
    detonate: '引爆', detonateDamage: '引爆', detonateRadius: '引爆', detonateSplash: '引爆',
    consumeOnHit: '表现与消耗', color: '表现与消耗'
  };
  MODULES.mark.fields.forEach(function (f) { if (MARK_SECTIONS[f.key]) f.section = MARK_SECTIONS[f.key]; });

  /* 旧版只有一个 mode（dash / retreat / blink / orbit）；
     现拆成「轨迹 + 方向来源 + 速度曲线」三个正交维度，这里做无副作用的兼容归一化。
     优先复用运动器引擎的实现，未被浏览器加载时（如 node 单测）用同表兜底。 */
  var MOTION_LEGACY = {
    dash: { track: 'line', dirFrom: 'toTarget', ease: 'easeIn' },
    retreat: { track: 'line', dirFrom: 'awayTarget', ease: 'easeIn' },
    blink: { track: 'instant', dirFrom: 'toTarget', ease: 'linear' },
    orbit: { track: 'orbit', dirFrom: 'perp', ease: 'linear' }
  };
  function normalizeMotion(p) {
    var d = defaults('motion');
    if (root.MotionEngine && root.MotionEngine.normalize) return root.MotionEngine.normalize(p, d);
    var out = Object.assign({}, d, p || {});
    var lg = p && p.mode && p.track == null ? MOTION_LEGACY[p.mode] : null;
    // 与引擎保持一致：旧 mode 只补缺失字段，不覆盖用户显式设置的方向 / 曲线
    if (lg) {
      out.track = lg.track;
      if (p.dirFrom == null) out.dirFrom = lg.dirFrom;
      if (p.ease == null) out.ease = lg.ease;
    }
    return out;
  }

  /* ============================================================
     宿主绑定层（Host Binding）：让「连线」真正承载属性归属
     ------------------------------------------------------------
     载体（host）= 能独立生成实体的模块：投射物 / 光环 / 指向性 / 区域残留。
     其它模块连在某个载体之后，属性就只作用于「这个载体创建的那批实体」；
     上游找不到载体（或显式选「技能整体」）的模块是技能级公共效果，
     对本技能所有实体都生效 —— 这也是旧存档 / 旧预设的默认行为。
     例：投射物A → 像素特效 → 伤害结算，三项属性编成 A 专属的一组；
         投射物B 另接一套特效与伤害，两组互不串味，也不再被 merge 成一份。
     ============================================================ */
  var HOST_TYPES = { projectile: 1, aura: 1, targeted: 1, zone: 1 };
  var HOST_LABELS = { projectile: '投射物', aura: '光环', targeted: '指向性', zone: '区域残留' };
  // 除「触发 / 属性」外，所有模块都能声明作用对象（载体自身也可以，用于载体嵌套）
  var BINDABLE = {};
  Object.keys(MODULES).forEach(function (t) { if (t !== 'source' && t !== 'stats' && t !== 'delay') BINDABLE[t] = 1; });
  var HOST_BASE_OPTIONS = [['auto', '按连线自动识别'], ['global', '技能整体（公共效果）']];
  Object.keys(BINDABLE).forEach(function (t) {
    MODULES[t].fields.unshift({
      key: 'bindTo', label: '作用对象', type: 'select', def: 'auto',
      options: HOST_BASE_OPTIONS.slice(),
      hint: '按连线自动：本模块连在哪个「投射物 / 光环 / 指向性 / 区域」后面，属性就只作用于它创建的那批实体；上游找不到载体时作为技能级公共效果，作用于本技能全部实体。也可手动指定某个载体，或强制「技能整体」'
    });
  });
  // 光环 / 指向 / 区域也支持命名：多载体时便于在下拉与诊断里精确辨认
  ['targeted', 'aura', 'zone'].forEach(function (typ) {
    MODULES[typ].fields.splice(1, 0, t('name', '命名（自定义名称）', '', '给这个载体起个名字，便于在「作用对象」下拉、运动器绑定与组合诊断里精确锁定；留空按类型显示'));
  });
  /** 后台渲染属性面板前调用：把当前图里的载体节点注入「作用对象」下拉 */
  function setHosts(graph) {
    var opts = HOST_BASE_OPTIONS.slice();
    ((graph && graph.nodes) || []).forEach(function (n) {
      if (!n || !HOST_TYPES[n.type]) return;
      var nm = String((n.params && n.params.name) || '').trim();
      opts.push([n.id, HOST_LABELS[n.type] + (nm ? '「' + nm + '」' : '') + ' · 单独作用']);
    });
    Object.keys(BINDABLE).forEach(function (t) {
      var f = MODULES[t].fields.find(function (x) { return x.key === 'bindTo'; });
      if (f) f.options = opts;
    });
    return opts;
  }

  /* ============================================================
     作用范围（Range Determination）：让「打到哪里」成为一等公民
     ------------------------------------------------------------
     载体自带一份判定区域（由投递形态 / 范围判定模块算出）；
     每个效果模块还能单独缩窄自己的判定区域：
       inherit   跟随载体判定（默认，旧存档就是这个口径）
       custom    用本模块自己的半径 + 圆心
       unlimited 不受范围限制（全场型技能 / 旧行为兜底）
     判定结果在编译期写进视图，对局端与试放端只消费同一份描述，不再各算一遍。
     ============================================================ */
  var RANGE_MODULES = {
    element: 1, damage: 1, impact: 1, status: 1, mark: 1, fx: 1, particles: 1, echo: 1, split: 1
  };
  var RANGE_FIELDS = [
    sel('rangeMode', '作用范围', 'inherit', [
      ['inherit', '跟随载体判定'], ['custom', '自定义半径'], ['unlimited', '不限范围']
    ], '跟随载体判定：本模块只作用于落在载体「范围判定」区域内的目标；自定义半径：按下面的半径与圆心单独判定；不限范围：恢复到旧版「打到唯一对手」的行为'),
    n('rangeRadius', '自定义判定半径', 0, 0, 600, 5, '作用范围=自定义半径 时生效；0 = 沿用载体判定半径'),
    sel('rangeOrigin', '判定圆心', 'impact', [
      ['impact', '命中 / 落点'], ['caster', '我方（施法者）'], ['opponent', '敌方（对手）']
    ], '自定义半径时以哪里为圆心量距离；我方=绕自己弹珠、敌方=绕对手弹珠；射线带恒以施法者为起点'),
    n('rangeMaxTargets', '本模块目标上限', 0, 0, 20, 1, '0 = 不限；只影响本模块，不影响载体上其它模块')
  ];
  Object.keys(RANGE_MODULES).forEach(function (typ) {
    RANGE_FIELDS.forEach(function (f) {
      var copy = Object.assign({}, f, { options: f.options ? f.options.map(function (o) { return o.slice(); }) : undefined, section: '作用范围' });
      MODULES[typ].fields.push(copy);
    });
  });

  /* 这些字段是「范围 / 时长 / 间隔」，多个同类模块并存时取最大而非相加。
     相加会把两个默认 3 秒的墙面残留变成 6 秒、两个默认 60 半径变成 120。 */
  var MERGE_MAX = {
    damage: { wallDuration: 1, wallRadius: 1, wallTouchInterval: 1, rangeRadius: 1, rangeMaxTargets: 1 },
    impact: { hitStop: 1, chainRange: 1, aoeRadius: 1, rangeRadius: 1, rangeMaxTargets: 1 }
  };

  var TYPES = Object.keys(MODULES);

  function defaults(type) {
    var d = {};
    (MODULES[type] ? MODULES[type].fields : []).forEach(function (f) {
      d[f.key] = Array.isArray(f.def) ? f.def.slice() : (f.def && typeof f.def === 'object' ? Object.assign({}, f.def) : f.def);
    });
    return d;
  }
  function uid(p) { return (p || 'nd') + '_' + Math.random().toString(36).slice(2, 9); }
  function node(type, x, y, params) {
    return { id: uid(type), type: type, x: x, y: y, params: Object.assign(defaults(type), params || {}) };
  }

  function makeGraph(nodes, edges) { return { nodes: nodes, edges: edges }; }

  /* 起始图：触发来源 → 目标·锁定 → 属性。
     「目标 · 锁定」是所有果实的必需节点，保证新建 / 补图 / 重置得到的果实
     都有明确的指向单位，且按逻辑链路串在 source 之后、其它模块之前。
     起始图仍不含投射物 / 特效 / 伤害，旧版被动技能补图时不会凭空多出弹体。 */
  function starterGraph(skill) {
    var s = node('source', 40, 90), sel = node('select', 180, 90), st = node('stats', 320, 90);
    sel.params.side = 'enemyOne';   // 默认锁定最近敌人，保持「打对手」的直觉行为
    return makeGraph([s, sel, st], [{ from: s.id, to: sel.id }, { from: sel.id, to: st.id }]);
  }

  /** 合并同类单例节点：数值相加 / 布尔取或 / 枚举取最后 / 颜色取最后 */
  function merge(type, list) {
    var out = defaults(type);
    var fields = MODULES[type].fields;
    fields.forEach(function (f) {
      var vals = list.map(function (p) { return p[f.key]; }).filter(function (v) { return v !== undefined && v !== null; });
      if (!vals.length) return;
      if (f.type === 'number') {
        // 范围 / 时长 / 间隔类字段取最大，避免多节点时把默认值累加放大
        if (MERGE_MAX[type] && MERGE_MAX[type][f.key]) {
          out[f.key] = vals.reduce(function (a, b) { return Math.max(Number(a) || 0, Number(b) || 0); }, 0);
        } else out[f.key] = vals.reduce(function (a, b) { return Number(a) + Number(b); }, 0);
      }
      else if (f.type === 'bool') out[f.key] = vals.some(Boolean);
      else if (f.type === 'ramp') out[f.key] = vals[vals.length - 1].slice();
      else out[f.key] = vals[vals.length - 1];
    });
    return out;
  }

  /* ---- 命中判定 / 伤害对象的共享口径（对局 game.js 与试放 admin.js 共用同一套判断）---- */
  var HIT_KIND_LABEL = {
    body: '弹珠碰撞', projectile: '投射物命中', area: '范围命中', direct: '直接命中',
    cast: '施放结算', wall: '击飞撞墙', auto: '自动'
  };
  /** 节点实际生效的命中来源：编译期已把 auto 落成具体值，这里兼容未编译的原始参数 */
  function damageKindOf(node) {
    var k = node && (node._hitKind || node.hitKind);
    return (k && k !== 'auto') ? k : 'direct';
  }
  /** 本次命中来源是否被该节点接受。kind 为空 = 没有「碰撞瞬间」的结算（DoT / 区域 tick /
      印记引爆 / 回响），此时不按来源过滤，保持旧行为。 */
  function damageAcceptsKind(node, kind) {
    if (!kind) return true;
    return damageKindOf(node) === kind;
  }
  /** 命中时组里是否存在「必须真实接触」的伤害（弹珠碰撞 / 投射物命中）。
      有 => 没有投射物 / 指向性的技能不能再走「必中直击」，否则就是隔空扣血。 */
  function onHitNeedsContact(g) {
    if (!g) return false;
    var list = (g.damageList && g.damageList.length) ? g.damageList : (g.damage ? [g.damage] : []);
    for (var i = 0; i < list.length; i++) {
      var k = damageKindOf(list[i]);
      if (k === 'body' || k === 'projectile') return true;
    }
    return false;
  }
  /** 取出该组里符合「命中来源 + 伤害对象」的伤害节点。
      affect='enemy' → 敌方与双方；affect='self' → 自身与双方。 */
  function damageNodesFor(g, kind, affect) {
    var list = (g && g.damageList && g.damageList.length) ? g.damageList
      : ((g && g.damage) ? [g.damage] : []);
    return list.filter(function (d) {
      var af = d._affect || d.affect || 'enemy';
      var okAffect = affect === 'self' ? (af === 'self' || af === 'both') : (af !== 'self');
      return okAffect && damageAcceptsKind(d, kind);
    });
  }

  /** 整个技能里最大的击退力度（跨事件组）。
      击退是「命中」这个动作的物理效果：伤害节点即使配在「撞墙时」，
      技能打中目标时也要先把人推开，否则永远撞不到墙、撞墙伤害成了死配置。 */
  function skillKnockback(C) {
    var kb = 0;
    EVENT_KEYS.forEach(function (ev) {
      var g = C && C.events && C.events[ev];
      var list = (g && g.damageList) ? g.damageList : [];
      list.forEach(function (d) { kb = Math.max(kb, Number(d.knockback) || 0); });
    });
    // 未编译的原始技能：退化成扫节点参数
    if (!C || !C.events) {
      ((C && C.graph && C.graph.nodes) || []).forEach(function (n) {
        if (n && n.type === 'damage') kb = Math.max(kb, Number((n.params || {}).knockback) || 0);
      });
    }
    return kb;
  }
  /** 这个技能是否必须「真实接触」才能把命中组送到目标。
      除了命中组里的弹珠碰撞 / 投射物伤害，还有一种特殊情况：
      只配了「撞墙时」伤害 + 自身位移（冲锋类）——也得先撞上人再谈击飞撞墙。 */
  function skillNeedsContact(C) {
    var g = C && C.events && C.events.onHit;
    if (onHitNeedsContact(g)) return true;
    var wall = C && C.events && C.events.onWall;
    var hasWall = !!(wall && (wall.damageList || []).some(function (d) {
      return (Number(d.base) || 0) + (Number(d.pctMaxHp) || 0) > 0;
    }));
    var selfMotion = false;
    var nodes = (C && C.graph && C.graph.nodes) || [];
    nodes.forEach(function (n) {
      if (n && n.type === 'motion' && ((n.params && n.params.scope) || 'self') === 'self') selfMotion = true;
    });
    return !!(hasWall && selfMotion);
  }

  /* ---- 目标 · 锁定：把「作用在谁身上」解析成实体列表 ----
     C 可以是编译结果或任意视图（view 都带 select）；entities 缺省由调用方传入。
     返回的数组一定存在（没有合法目标时为空数组），调用方据此决定是否结算。 */
  function selectTargets(C, caster, entities) {
    var cfg = (C && C.select) || {};
    var mode = cfg.side || 'self';
    var all = (entities || []).filter(function (e) {
      return e && !e.dead && !(e.hp != null && e.hp <= 0);
    });
    // 自身：施法者本人（即使实体表里没有也补上）
    if (mode === 'self') return caster ? [caster] : [];
    var enemySide = caster && caster.side === 'player' ? 'enemy' : 'player';
    var isEnemy = mode === 'enemyOne' || mode === 'enemyMany';
    var pool = all.filter(function (e) {
      if (e === caster) return false;
      if (isEnemy) return e.side === enemySide || (caster && e.side !== caster.side);
      return caster ? e.side === caster.side : true;
    });
    if (!pool.length) return [];
    var ang = function (e) { return caster ? Math.hypot(e.x - caster.x, e.y - caster.y) : 0; };
    var pick = cfg.pick || 'nearest';
    if (pick === 'random') {
      pool = pool.slice();
      for (var i = pool.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
      }
    } else if (pick === 'farthest') {
      pool.sort(function (a, b) { return ang(b) - ang(a); });
    } else if (pick === 'lowestHp') {
      pool.sort(function (a, b) { return (a.hp || 0) - (b.hp || 0); });
    } else if (pick === 'highestHp') {
      pool.sort(function (a, b) { return (b.hp || 0) - (a.hp || 0); });
    } else {
      pool.sort(function (a, b) { return ang(a) - ang(b); });
    }
    var many = mode === 'enemyMany' || mode === 'allyMany';
    var n = many ? Math.max(1, Math.min(4, Math.round(Number(cfg.count) || 1))) : 1;
    return pool.slice(0, n);
  }

  /** 「命中时」组里是否有实际内容 —— 用于判定「没有投递模块」的技能要不要走「直接命中」。
   *  对局（game.js）与试放（admin.js）共用同一判定，避免两端对「算不算有输出」理解不一致；
   *  空组（只剩默认值的 damage/impact）不触发，防止纯被动技能凭空震屏。 */
  function hitHasContent(g) {
    if (!g) return false;
    var lists = ['elements', 'fx', 'particles', 'status', 'mark', 'zone', 'echo', 'aura', 'split', 'shield', 'motion'];
    for (var i = 0; i < lists.length; i++) {
      if (g[lists[i]] && g[lists[i]].length) return true;
    }
    var d = g.damage || {};
    if ((Number(d.base) || 0) + (Number(d.pctMaxHp) || 0) > 0) return true;
    if (g.impact && (Number(g.impact.aoeRadius) || 0) > 0) return true;
    return false;
  }

  /* ---- 作用域桶：按「事件 × 模块类型」存放节点参数，供分组构建复用 ---- */
  function emptyBuckets() {
    var o = {};
    EVENT_KEYS.forEach(function (ev) {
      o[ev] = {};
      EVENT_SLOTS.forEach(function (s) { o[ev][s] = []; });
    });
    return o;
  }
  function copyBuckets(src) {
    var o = emptyBuckets();
    EVENT_KEYS.forEach(function (ev) {
      EVENT_SLOTS.forEach(function (s) { o[ev][s] = ((src && src[ev] && src[ev][s]) || []).slice(); });
    });
    return o;
  }
  function joinBuckets(a, b) {
    var o = copyBuckets(a);
    EVENT_KEYS.forEach(function (ev) {
      EVENT_SLOTS.forEach(function (s) { o[ev][s] = o[ev][s].concat(((b && b[ev] && b[ev][s]) || [])); });
    });
    return o;
  }
  /** 把四个事件组的节点摊平到 onCast：持续型载体（光环 / 区域）没有「命中」瞬间，
   *  凡是连到它的模块，无论触发事件设成哪一个，都在它生成 / 每次结算时生效。 */
  function flattenBuckets(b) {
    var o = emptyBuckets();
    EVENT_KEYS.forEach(function (ev) {
      EVENT_SLOTS.forEach(function (s) { o.onCast[s] = o.onCast[s].concat(((b && b[ev] && b[ev][s]) || [])); });
    });
    return o;
  }
  /** 桶 → 运行时事件组。与旧版 compile 的 events / wallHazard / projectileFx 完全同构，
   *  只是抽成函数，好让「技能级公共组」和「每个宿主的专属组」共用一套规则。 */
  function buildGroups(tmp) {
    var events = {};
    EVENT_KEYS.forEach(function (ev) {
      events[ev] = {
        elements: tmp[ev].element,
        fx: tmp[ev].fx,
        wallFx: tmp[ev].fx.filter(function (f) { return f.attach === 'wallFace'; }),
        particles: tmp[ev].particles,
        status: tmp[ev].status,
        motion: tmp[ev].motion,
        mark: tmp[ev].mark,
        shield: tmp[ev].shield,
        split: tmp[ev].split,
        zone: tmp[ev].zone,
        echo: tmp[ev].echo,
        aura: tmp[ev].aura,
        damage: merge('damage', tmp[ev].damage),
        impact: merge('impact', tmp[ev].impact),
        // 保留逐节点原参数：合并后的 damage / impact 只作兼容兜底，
        // 真正结算时按每个节点自己的「作用范围」逐条过滤，互不串味
        damageList: tmp[ev].damage.slice(),
        impactList: tmp[ev].impact.slice()
      };
      // 「延迟」模块：把本事件组 damage 节点的最大累计延迟带到合并对象上，
      // 供「持续伤害(跟随)」按延迟延后触发（直接命中伤害由碰撞时刻结算，不受此延迟影响）
      events[ev].damage._delay = tmp[ev].damage.reduce(function (mx, d) { return Math.max(mx, Number(d._delay) || 0); }, 0);
    });
    var allDamage = [], allFx = [];
    EVENT_KEYS.forEach(function (ev) {
      allDamage = allDamage.concat(tmp[ev].damage);
      allFx = allFx.concat(tmp[ev].fx);
      events[ev].wallHazard = wallHazardOf(tmp[ev].damage, tmp[ev].fx);
    });
    var wallHazard = wallHazardOf(allDamage, allFx);
    EVENT_KEYS.forEach(function (ev) {
      events[ev].fx.forEach(function (f) {
        if (f.attach === 'wallFace') f._wallDuration = wallHazard.wallDuration;
      });
    });
    var projectileFx = [], wallFx = [], fxByHostNode = {};
    EVENT_KEYS.forEach(function (ev) {
      events[ev].fx.forEach(function (f) {
        var hid = f._hostId || '', ht = f._hostType || '';
        /* 特效按「连线归属」登记到载体节点名下：区域 / 光环 / 指向性也能拥有自己的外观，
           运行时创建实体时据此把特效挂上去，而不是一律当成投射物皮肤。 */
        if (hid && (ht === 'projectile' || ht === 'zone' || ht === 'aura' || ht === 'targeted')) {
          if (!fxByHostNode[hid]) fxByHostNode[hid] = [];
          if (fxByHostNode[hid].indexOf(f) < 0) fxByHostNode[hid].push(f);
        }
        /* 投射物皮肤只认「归属投射物」或「技能级公共」的特效。
           以前只看 attach，导致连到区域残留的特效（attach 默认 projectile）被误收进
           projectileFx：区域自己拿不到特效，只剩「区域颜色」纯色圆。 */
        var at = f.attach || 'projectile';
        if ((at === 'projectile' || at === 'host') &&
            (!hid || ht === 'projectile') && projectileFx.indexOf(f) < 0) projectileFx.push(f);
        if (f.attach === 'wallFace' && wallFx.indexOf(f) < 0) wallFx.push(f);
      });
    });
    return { events: events, projectileFx: projectileFx, wallFx: wallFx,
      wallHazard: wallHazard, fxByHostNode: fxByHostNode };
  }
  /** 沿入边向上游按层回溯，找到距离最近的载体节点；找不到返回 ''（技能级公共）。
   *  同层多个载体时取连线顺序里靠后的那个，行为稳定可预期。 */
  function upstreamHost(id, prev, byId) {
    var queue = (prev[id] || []).slice(), seen = Object.create(null);
    seen[id] = 1;   // 成环时不能绕一圈回来把「自己」当成上游宿主
    while (queue.length) {
      var layer = queue; queue = [];
      for (var i = 0; i < layer.length; i++) {
        var nid = layer[i];
        if (seen[nid]) continue;
        seen[nid] = 1;
        var nd = byId[nid];
        if (nd && HOST_TYPES[nd.type]) return nid;
        (prev[nid] || []).forEach(function (p) { if (!seen[p]) queue.push(p); });
      }
    }
    return '';
  }

  /** 编译结果 → 「公共视图」：只含未绑定到任何载体的节点，用于施放时 / 无载体技能。 */
  function publicView(C) { return (C && C._views && C._views.public) || C; }
  /** 编译结果 → 「某载体视图」：公共组 + 该载体专属组，且投射物/指向性属性换成这一份。
   *  运行时把视图直接挂在实体上（q._C），命中 / 撞墙 / 消失全链路无需再判断归属。 */
  function viewFor(C, hostId) {
    if (!C || !C._views) return C;
    if (!hostId) return C._views.public || C;
    return C._views.hosts[hostId] || C._views.public || C;
  }
  /** 「仅专属视图」：只含绑定到该载体的节点，用于每个载体各自的施放表现 / 持续结算。 */
  function exclusiveView(C, hostId) {
    return (C && C._views && C._views.exclusive && C._views.exclusive[hostId]) || publicView(C);
  }
  /** 由模块参数里的 _nodeId 找回它所属的载体专属视图（光环 / 区域实体用）。 */
  function viewOfNode(C, nodeId) {
    if (!C || !C.hosts || !nodeId) return publicView(C);
    var h = C.hosts.filter(function (x) { return x.id === nodeId; })[0];
    return h ? exclusiveView(C, h.id) : publicView(C);
  }
  /** 取载体列表；topOnly=true 时排除「挂在别的载体上的子载体」。 */
  function hostsOf(C, type, topOnly) {
    if (!C || !C.hosts) return [];
    return C.hosts.filter(function (h) {
      if (type && h.type !== type) return false;
      if (topOnly && h.parentId) return false;
      return true;
    });
  }
  /** 给后台用的组合诊断：每个载体挂了哪些模块、有哪些容易踩空的组合。 */
  function describeBindings(C) {
    var out = { hosts: [], issues: [] };
    if (!C || !C.hosts) return out;
    var byId = {};
    (C.nodes || []).forEach(function (n) { byId[n.id] = n; });
    C.hosts.forEach(function (h) {
      var labels = (h.bound || []).map(function (id) {
        var n = byId[id];
        if (!n || !MODULES[n.type]) return '';
        var nm = String((n.params && n.params.name) || '').trim();
        return (MODULES[n.type].short || MODULES[n.type].label) + (nm ? '「' + nm + '」' : '');
      }).filter(Boolean);
      out.hosts.push({ id: h.id, label: h.label, type: h.type, bound: (h.bound || []).slice(), boundLabels: labels, parentId: h.parentId });
    });
    var proj = C.hosts.filter(function (h) { return h.type === 'projectile'; });
    var tg = C.hosts.filter(function (h) { return h.type === 'targeted'; });
    if (tg.length && proj.length) out.issues.push('同时存在「指向性」与「投射物」：指向性优先，投射物不会发射');
    if (tg.length > 1) out.issues.push('存在多个「指向性」模块：只有第一个会生效');
    if (proj.length > 1) {
      var forms = {};
      proj.forEach(function (h) { forms[(h.cfg && h.cfg.delivery) || 'projectile'] = 1; });
      if (Object.keys(forms).length > 1) out.issues.push('多个投射物的「投递形态」不一致：各自按自身形态结算');
      proj.forEach(function (h) {
        if (!(h.bound || []).length) out.issues.push(h.label + ' 后面没有连接任何模块：只按自身属性发射，技能级公共效果仍会生效');
      });
    }
    return out;
  }

  /* ============================================================
     范围判定：对局端与试放端共用的唯一口径
     ------------------------------------------------------------
     旧链路里「近战距离 / 区域半径 / 射线长度」只在 game.js 的两个局部函数里
     被部分使用，admin.js 试放完全不读；而 formTargets('melee') 无条件返回 [opp]、
     aoe 落点直接取「到对手的距离」—— 于是所有模块都退化成「打到唯一对手」，
     视觉上就是全图范围判定。这里把判定区域编成一份描述，两端只消费它。
     ============================================================ */
  function numOr(v, d) { var x = Number(v); return isFinite(x) ? x : d; }
  function normAngle(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }

  function rangeLabel(d) {
    if (!d) return '无范围判定';
    var names = { circle: '圆形', cone: '扇形', line: '射线带', ring: '环形', contact: '碰撞点' };
    var s = names[d.shape] || String(d.shape);
    if (d.shape === 'line') s += ' 长 ' + Math.round(d.length) + ' / 半宽 ' + Math.round(d.width);
    else if (d.shape === 'contact') s += '';
    else s += ' 半径 ' + Math.round(d.radius);
    if (d.shape === 'cone') s += ' / ' + Math.round(d.angleDeg) + '°';
    if (d.shape === 'ring') s += '（内 ' + Math.round(d.innerRadius) + '）';
    if (d.castRange > 0) s += ' · 落点 ' + Math.round(d.castRange);
    if (d.maxTargets > 0) s += ' · 上限 ' + d.maxTargets;
    if (d.origin === 'caster') s += ' · 我方';
    else if (d.origin === 'opponent') s += ' · 敌方';
    return s;
  }

  /** 编译视图 → 判定区域描述（含绝对坐标）。
   *  C   = publicView / viewFor / exclusiveView 任一编译视图
   *  ctx = { caster, opponent, entities, angle, point, targets }
   *  未接「范围判定」模块时由投递形态自带参数生成；接了就用节点覆盖。 */
  function rangeDescriptor(C, ctx) {
    ctx = ctx || {};
    var hostId = (C && C._viewOf) || '';
    var byHost = (C && C.rangeByHost) || {};
    var R = byHost[hostId] || byHost[''] || null;
    var p = (C && C.projectile) || {};
    var form = p.delivery || 'projectile';
    var hostType = (C && C._hostType) || '';
    var caster = ctx.caster || { x: 0, y: 0, r: 0 };
    var opp = ctx.opponent || { x: 0, y: 0, r: 0 };
    var angle = (ctx.angle == null || !isFinite(ctx.angle))
      ? Math.atan2(opp.y - caster.y, opp.x - caster.x) : ctx.angle;
    var point = ctx.point || { x: opp.x, y: opp.y };

    var d = {
      form: form, shape: 'circle', radius: 0, innerRadius: 0, angleDeg: 360,
      length: 0, width: 0, castRange: 0, maxTargets: 0, pick: 'nearest', includeSelf: false,
      origin: 'impact', x: point.x, y: point.y, angle: angle,
      source: 'delivery', label: ''
    };
    if (hostType === 'targeted') {
      // 指向性：锁定目标结算，maxRange=0 表示不限距离（沿用原有判定语义）
      var mr = Math.max(0, numOr((C.targeted || {}).maxRange, 0));
      d.shape = mr > 0 ? 'circle' : 'contact'; d.radius = mr; d.origin = 'caster';
    } else if (hostType === 'aura' || hostType === 'zone') {
      // 持续型载体：以自身 / 落点为圆心持续结算，范围来自模块自带的 radius
      var ar = Math.max(0, numOr((C[hostType] || {}).radius, hostType === 'aura' ? 90 : 70));
      d.shape = 'circle'; d.radius = ar;
      d.origin = hostType === 'aura' ? 'caster' : 'impact';
    } else if (form === 'melee') {
      d.shape = 'circle'; d.radius = Math.max(0, numOr(p.meleeRange, 60));
      d.origin = 'caster';
    } else if (form === 'aoe') {
      d.shape = 'circle'; d.radius = Math.max(0, numOr(p.areaRadius, 80));
      d.origin = 'landing';
      // 旧版落点 = 到对手的距离（等于自动追踪全图）；改为按「落点距离 / 最大飞行距离」定长
      d.castRange = Math.max(0, numOr(p.castRange, 0)) || Math.max(0, numOr(p.range, 0)) || 260;
    } else if (form === 'ray') {
      d.shape = 'line'; d.length = Math.max(1, numOr(p.rayRange, 600));
      d.width = Math.max(0, numOr(p.rayWidth, 20)); d.origin = 'caster';
    } else {
      // 投射物 / 召唤分身：命中目标由物理碰撞决定，判定区就是碰撞点
      d.shape = 'contact'; d.radius = Math.max(0, numOr(p.size, 9)); d.origin = 'impact';
    }

    if (R) {
      d.source = 'module';
      if (R.shape) d.shape = R.shape;
      var rr = Math.max(0, numOr(R.radius, 0));
      if (rr > 0) d.radius = rr;
      d.innerRadius = Math.max(0, numOr(R.innerRadius, 0));
      if (d.shape === 'cone') d.angleDeg = Math.max(5, Math.min(360, numOr(R.angleDeg, 90)));
      if (d.shape === 'line') {
        d.length = Math.max(1, numOr(R.length, 600));
        d.width = Math.max(0, numOr(R.width, 20));
      }
      var cr = Math.max(0, numOr(R.castRange, 0));
      if (cr > 0) d.castRange = cr;
      d.maxTargets = Math.max(0, Math.round(numOr(R.maxTargets, 0)));
      d.pick = R.pick || 'nearest';
      d.includeSelf = !!R.includeSelf;
      var og = R.origin || 'auto';
      // 显式指定：我方 / 敌方 / 命中落点；auto 默认围绕施法者（自走 AoE 最常见），
      // 需要炸在敌人身上时选「命中 / 落点」或「敌方」
      if (og === 'caster') d.origin = 'caster';
      else if (og === 'opponent') d.origin = 'opponent';
      else if (og === 'impact') d.origin = 'impact';
      else if (og === 'auto') d.origin = 'caster';
      if (d.shape === 'line') d.origin = 'caster';   // 射线带恒以施法者为起点
    }

    // 按最终 origin 统一重算圆心，避免覆盖字段后坐标与形状不一致
    if (d.origin === 'caster') { d.x = caster.x; d.y = caster.y; }
    else if (d.origin === 'opponent') { d.x = opp.x; d.y = opp.y; }
    else if (d.origin === 'landing') {
      d.x = caster.x + Math.cos(angle) * d.castRange;
      d.y = caster.y + Math.sin(angle) * d.castRange;
    } else { d.origin = 'impact'; d.x = point.x; d.y = point.y; }
    d.label = rangeLabel(d);
    return d;
  }

  /** 目标是否落在某个判定形状内（t.r 计入体积，与碰撞口径一致）。 */
  function inRangeShape(d, t) {
    if (!d || !t) return true;
    var dx = t.x - d.x, dy = t.y - d.y, r = t.r || 0;
    var dist = Math.hypot(dx, dy);
    if (d.shape === 'contact') return true;
    if (d.shape === 'line') {
      var proj = dx * Math.cos(d.angle) + dy * Math.sin(d.angle);
      var perp = Math.abs(dx * Math.sin(d.angle) - dy * Math.cos(d.angle));
      return proj >= -r && proj <= d.length + r && perp <= d.width + r;
    }
    if (dist > d.radius + r) return false;
    if (d.shape === 'cone') {
      var half = Math.min(Math.PI, (d.angleDeg * Math.PI / 180) / 2);
      return Math.abs(normAngle(Math.atan2(dy, dx) - d.angle)) <= half;
    }
    if (d.shape === 'ring') return dist + r >= d.innerRadius;
    return true;   // circle
  }

  /** 区域内可结算目标列表：按距离近→远排序，再按目标上限截断。 */
  function targetsInRange(d, ctx) {
    ctx = ctx || {};
    var caster = ctx.caster;
    // 碰撞型（投射物 / 分身）：命中目标由物理引擎给出，几何判定不能凭空多打目标
    if (d && d.shape === 'contact') {
      return (ctx.targets && ctx.targets.length) ? ctx.targets.slice() : (ctx.opponent ? [ctx.opponent] : []);
    }
    var src = ctx.entities || [];
    var list = src.filter(function (t) {
      if (!t || t.dead || (t.hp != null && t.hp <= 0)) return false;
      if (d && d.includeSelf) return true;
      if (t === caster) return false;
      if (caster && t.side && caster.side && t.side === caster.side) return false;
      return true;
    });
    list = list.filter(function (t) { return inRangeShape(d, t); });
    if (d) {
      var pick = d.pick || 'nearest';
      list.sort(function (a, b) {
        if (pick === 'lowestHp' || pick === 'highestHp') {
          var ah = (a.hp == null ? Infinity : a.hp), bh = (b.hp == null ? Infinity : b.hp);
          return pick === 'lowestHp' ? ah - bh : bh - ah;
        }
        var da = Math.hypot(a.x - d.x, a.y - d.y), db = Math.hypot(b.x - d.x, b.y - d.y);
        return pick === 'farthest' ? db - da : da - db;
      });
      if (d.maxTargets > 0) list = list.slice(0, d.maxTargets);
    }
    return list;
  }

  /** 命中表现 / 落点：施放特效应该画在判定区域内，而不是画到全图另一侧的对手身上。 */
  function rangePoint(d, ctx) {
    ctx = ctx || {};
    if (!d) return ctx.point || { x: 0, y: 0 };
    if (d.origin === 'caster' && ctx.caster) return { x: ctx.caster.x, y: ctx.caster.y };
    if (d.origin === 'landing' || d.shape === 'line') return { x: d.x, y: d.y };
    if (ctx.point) return { x: ctx.point.x, y: ctx.point.y };
    return { x: d.x, y: d.y };
  }

  /** 单个模块自己的作用范围：inherit 跟随载体，custom 用自身半径与圆心，unlimited 不过滤。 */
  function moduleInRange(mod, d, target, ctx) {
    if (!mod || mod.rangeMode === 'unlimited') return true;
    if (!d || !target) return true;
    var mode = mod.rangeMode || 'inherit';
    // 碰撞型载体（投射物 / 分身）已由物理碰撞选出命中目标，
    // 「跟随载体判定」不再做二次几何收窄，否则会把贴着弹体边缘的目标误判出界
    if (mode === 'inherit' && d.shape === 'contact') return true;
    var radius = (mode === 'custom') ? Math.max(0, numOr(mod.rangeRadius, 0)) : d.radius;
    if (mode === 'custom' && !(radius > 0)) radius = d.radius;
    var caster = ctx && ctx.caster;
    var point = (ctx && ctx.point) || { x: d.x, y: d.y };
    var ox = d.x, oy = d.y;
    if (mode === 'custom') {
      var opp2 = ctx && ctx.opponent;
      if (mod.rangeOrigin === 'caster' && caster) { ox = caster.x; oy = caster.y; }
      else if (mod.rangeOrigin === 'opponent' && opp2) { ox = opp2.x; oy = opp2.y; }
      else { ox = point.x; oy = point.y; }
    }
    if (d.shape === 'line' && caster) { ox = caster.x; oy = caster.y; }
    var sub = {
      shape: d.shape === 'contact' ? 'circle' : d.shape,
      radius: radius, innerRadius: d.innerRadius, angleDeg: d.angleDeg,
      length: d.length, width: d.width, angle: d.angle, x: ox, y: oy
    };
    return inRangeShape(sub, target);
  }

  /** 按某模块的作用范围筛目标，并应用它自己的目标上限。 */
  function moduleTargets(list, mod, d, ctx) {
    var out = (list || []).filter(function (t) { return moduleInRange(mod, d, t, ctx); });
    var cap = Math.max(0, Math.round(numOr(mod && mod.rangeMaxTargets, 0)));
    return cap > 0 ? out.slice(0, cap) : out;
  }

  /** 编译节点图：从所有 source 出发做 BFS，只有可达节点生效；再按「触发事件」分组（类型化多端口） */
  var EVENT_GROUP_TYPES = {
    element: 1, fx: 1, particles: 1, impact: 1, damage: 1, status: 1,
    motion: 1, mark: 1, shield: 1, split: 1, zone: 1, echo: 1, aura: 1
  };
  var EVENT_DEFAULT = {
    element: 'onHit', damage: 'onHit', fx: 'onHit', particles: 'onHit', impact: 'onHit', status: 'onHit',
    mark: 'onHit', split: 'onHit', zone: 'onHit', echo: 'onHit',
    motion: 'onCast', shield: 'onCast', aura: 'onCast'
  };
  // 这些类型只存在于事件组里，不参与单例合并
  var EVENT_ONLY = { status: 1, motion: 1, mark: 1, shield: 1, split: 1, zone: 1, echo: 1, aura: 1, select: 1, delay: 1 };
  var EVENT_SLOTS = ['element', 'fx', 'particles', 'status', 'damage', 'impact', 'motion', 'mark', 'shield', 'split', 'zone', 'echo', 'aura'];

  function compile(skill) {
    var g = (skill && skill.graph) || starterGraph(skill);
    var nodes = (g.nodes || []).filter(function (x) { return x && MODULES[x.type]; });
    var byId = {}; nodes.forEach(function (x) { byId[x.id] = x; });
    var next = {}, prev = {};
    (g.edges || []).forEach(function (e) {
      if (!byId[e.from] || !byId[e.to]) return;
      (next[e.from] || (next[e.from] = [])).push(e.to);
      (prev[e.to] || (prev[e.to] = [])).push(e.from);
    });
    var sources = nodes.filter(function (x) { return x.type === 'source'; });
    var roots = sources.length ? sources.map(function (x) { return x.id; }) : nodes.map(function (x) { return x.id; });
    var seen = {}, queue = roots.slice();
    roots.forEach(function (id) { seen[id] = 1; });
    while (queue.length) {
      var cur = queue.shift();
      (next[cur] || []).forEach(function (to) { if (!seen[to]) { seen[to] = 1; queue.push(to); } });
    }
    /* 编辑器可以临时「停用」某个节点（n.enabled === false）：保留连线但不参与编译。
       旧数据没有这个字段，undefined !== false，行为完全不变。 */
    var live = nodes.filter(function (x) { return seen[x.id] && x.enabled !== false; });

    /* 「延迟」模块：下游所有模块相对触发事件延后 seconds 秒生效。
       沿全部可达边做最长路径松弛（延迟非负），取每个节点到根的最大累计延迟。
       延迟节点本身不进事件桶（EVENT_GROUP_TYPES 不含 delay），只负责把 seconds 传给下游。 */
    var nodeDelay = {};
    roots.forEach(function (id) { nodeDelay[id] = 0; });
    var _relax = true, _relaxGuard = 0;
    while (_relax && _relaxGuard++ < 10000) {
      _relax = false;
      live.forEach(function (x) {
        var u = x.id;
        if (nodeDelay[u] == null) nodeDelay[u] = 0;
        var add = (x.type === 'delay') ? (Number((x.params || {}).seconds) || 0) : 0;
        (next[u] || []).forEach(function (to) {
          var nd = nodeDelay[u] + add;
          if (nodeDelay[to] == null || nd > nodeDelay[to]) { nodeDelay[to] = nd; _relax = true; }
        });
      });
    }

    /* 「命中判定」自动解析：auto 按技能形态落到具体口径，编译期定死；
       运行时（对局 + 试放）只认节点的 _hitKind，不再各自猜。
         - 有投射物            → projectile（投射物命中）
         - 有范围判定          → area（近战 / 区域 / 射线判定命中）
         - 只有作用于自身的位移 → body（冲锋 / 突进：本体必须真的碰到对手才结算）
         - 都没有              → direct（必中直击，保持旧行为） */
    var hasProjectileHost = live.some(function (x) { return x.type === 'projectile'; });
    var hasRangeHost = live.some(function (x) { return x.type === 'range'; });
    var hasSelfMotion = live.some(function (x) {
      return x.type === 'motion' && ((x.params && x.params.scope) || 'self') === 'self';
    });
    var AUTO_HIT = hasProjectileHost ? 'projectile'
      : (hasRangeHost ? 'area' : (hasSelfMotion ? 'body' : 'direct'));

    /* 三套节点桶：
       all                 = 全部可达节点（旧行为，保持 C.events / C.projectileFx 原样）
       scoped['']          = 未绑定载体的节点 → 技能级公共效果
       scoped[hostId]      = 只绑定到该载体的节点 → 该实体的专属属性 */
    var all = emptyBuckets(), scoped = { '': emptyBuckets() }, ownerOf = {}, boundOf = {};
    live.forEach(function (x) { if (HOST_TYPES[x.type]) scoped[x.id] = emptyBuckets(); });
    // 节点 id → 编译后归一化对象；路由计算与跨视图补字段时按 _nodeId 反查
    var normalizedById = {};

    live.forEach(function (x) {
      if (x.type !== 'source' && x.type !== 'stats') {
        var bind = (x.params || {}).bindTo || 'auto';
        var owner = '';
        if (bind !== 'auto' && bind !== 'global' && scoped[bind] && byId[bind] && HOST_TYPES[byId[bind].type]) owner = bind;
        else if (bind !== 'global') owner = upstreamHost(x.id, prev, byId);
        if (owner === x.id) owner = '';   // 自环 / 手动指定到自己：载体不能绑定自己
        if (owner && !scoped[owner]) owner = '';
        ownerOf[x.id] = owner;
        if (owner) (boundOf[owner] || (boundOf[owner] = [])).push(x.id);
      } else ownerOf[x.id] = '';
      var ownBucket = ownerOf[x.id] ? scoped[ownerOf[x.id]] : scoped[''];

      if (!EVENT_GROUP_TYPES[x.type]) return;
      var raw = x.params || {};
      var isMotion = x.type === 'motion';
      if (isMotion) {
        /* 图结构自动识别：运动器前面「直接相连」的投射物节点，取其命名作为默认绑定目标。
           已按连线归属到某投射物时优先用那个投射物的命名，绑定更紧密。 */
        var incoming = (g.edges || []).filter(function (e) { return e.to === x.id; })
          .map(function (e) { return byId[e.from]; })
          .filter(function (s) { return s && s.type === 'projectile'; });
        var pn = '';
        var ownerNode = ownerOf[x.id] && byId[ownerOf[x.id]];
        if (ownerNode && ownerNode.type === 'projectile') pn = (ownerNode.params || {}).name || '';
        if (!pn && incoming.length) pn = (incoming[incoming.length - 1].params || {}).name || '';
        raw = Object.assign({}, raw, { _autoBind: pn });
      }
      var params = Object.assign(defaults(x.type), raw);
      /* 旧存档的印记节点没有「层数上限」，当年是硬编码 9 层；保住原强度，不让老技能被悄悄削弱 */
      if (x.type === 'mark' && raw.maxStacks == null) params.maxStacks = 9;
      /* 特效节点带一份来源 id：运行时用它做「同一目标上的同类特效只保留一份」的键 */
      if (x.type === 'fx') params._nid = x.id;
      var evKey = (params.triggerEvent && EVENT_KEYS.indexOf(params.triggerEvent) >= 0) ? params.triggerEvent : (EVENT_DEFAULT[x.type] || 'onHit');
      // motion 用「原始 params」归一化：才能识别旧存档里只有 mode、没有 track 的节点
      var normalized = isMotion ? normalizeMotion(raw) : params;
      if (isMotion) { normalized.bindTo = params.bindTo; normalized._autoBind = params._autoBind; }
      // 运行时反查：这个节点属于哪个载体、自己是哪张节点（光环 / 区域实体据此取专属结算组）
      normalized._nodeId = x.id;
      normalizedById[x.id] = normalized;
      normalized._hostId = ownerOf[x.id] || '';
      var ownN = normalized._hostId && byId[normalized._hostId];
      normalized._hostType = ownN ? ownN.type : '';
      // 「延迟」模块：本节点到根的最大累计延迟（秒）；0 = 立即生效
      normalized._delay = Math.max(0, Number(nodeDelay[x.id]) || 0);
      // 归属的事件组（编辑器语义条直接读它，避免编辑器自己再推一遍）
      normalized._event = evKey;
      /* 伤害节点带上编译期定死的「命中判定」与「伤害对象」：
         运行时按这两个字段决定「这次命中算不算数」「打谁」，两端口径完全一致 */
      if (x.type === 'damage') {
        /* 命中判定只在「触发事件 = 命中时」时有意义：
           施放时 / 撞墙时各自是独立的结算时机，用 cast / wall 标记，
           避免「施放时的伤害」被 auto 解析成弹珠碰撞而永远打不出去。 */
        var hk = (params.hitKind && params.hitKind !== 'auto') ? params.hitKind : AUTO_HIT;
        if (evKey === 'onCast') hk = 'cast';
        else if (evKey === 'onWall') hk = 'wall';
        normalized._hitKind = hk;
        normalized._affect = params.affect || 'enemy';
      }
      all[evKey][x.type].push(normalized);
      ownBucket[evKey][x.type].push(Object.assign({}, normalized));
    });

    /* 「弹珠移动路径」特效 → 下游「伤害·结算」持续伤害路由：
       当一条像素特效是「路径移动路径」模式，且它的下游（沿边可达）存在一个勾选了
       「持续伤害(跟随)」的伤害节点时，把该伤害节点的持续伤害配置挂到路径特效节点上，
       让持续伤害区在路径「每个落点」（每 pathInterval）生成 —— 即弹珠走过的地方都留下
       一片判定区，而不是只在命中点生成一个跟随施法者的红圈。这样「路径特效 + 持续伤害」
       组合出「移动留下持续伤害轨迹」，与路径表现严格对齐。该伤害节点本身不再生成
       独立的跟随红圈（避免重复），标记 _routedToPath 跳过 applyExtraModules 的单独生成。 */
    var fxNodePathDot = {}, routedDamageIds = {};
    (function routePathDots() {
      var typeOf = {};
      (g.nodes || []).forEach(function (n) { if (n && n.id) typeOf[n.id] = n.type; });
      live.forEach(function (x) {
        if (x.type !== 'fx') return;
        var p = Object.assign(defaults('fx'), x.params || {});
        if (p.attach !== 'path') return;
        // 沿边正向 BFS，收集可到达的「伤害·结算」节点（带持续伤害）
        var seen = {}, q = [x.id]; seen[x.id] = true;
        var cfgs = [];
        while (q.length) {
          var cur = q.shift();
          (next[cur] || []).forEach(function (to) {
            if (seen[to]) return; seen[to] = true;
            if (typeOf[to] === 'damage') {
              var d = Object.assign(defaults('damage'), (byId[to] && byId[to].params) || {});
              if (d.dotEnable && Number(d.dotDps) > 0) {
                // 路径落点上的持续伤害：固定在该落点（跟随方式强制 impact），
                // 与「弹珠移动路径」表现一致 —— 弹珠走过处都留下伤害区
                d.dotFollow = 'impact';
                d._routedToPath = true;
                cfgs.push(d);
                routedDamageIds[to] = true;
                // 直接写回该伤害节点的归一化对象：公共视图（all 桶）下不再单独生成跟随红圈
                if (normalizedById[to]) normalizedById[to]._routedToPath = true;
              }
            }
            q.push(to);
          });
        }
        if (cfgs.length) {
          fxNodePathDot[x.id] = cfgs;
          // 直接写回编译后归一化对象：该对象正是 result.events 里那份运行时特效节点，
          // 确保「公共视图」路径（all 桶）也带上 _pathDot，而不只是 scoped[''] 桶的视图
          if (normalizedById[x.id]) normalizedById[x.id]._pathDot = cfgs;
        }
      });
    })();

    /* 范围判定节点不进事件组，只按「作用对象」归到某个载体（或技能整体）。
       同一载体接多个时取第一个，行为稳定可预期。 */
    var rangeByHost = {};
    live.forEach(function (x) {
      if (x.type !== 'range') return;
      var owner = ownerOf[x.id] || '';
      if (!rangeByHost[owner]) rangeByHost[owner] = Object.assign(defaults('range'), x.params || {});
    });

    var groups = buildGroups(all);
    var events = groups.events;
    var pubGroups = buildGroups(scoped['']);

    var pick = function (t) { return live.filter(function (x) { return x.type === t; }).map(function (x) { return Object.assign(defaults(t), x.params || {}); }); };
    var multi = {}, single = {};
    TYPES.forEach(function (t) {
      var p = pick(t);
      if (MODULES[t].multi || t === 'source') multi[t] = p;
      else if (!EVENT_ONLY[t]) single[t] = merge(t, p);   // 事件型模块只在 events 中，不进 single
    });
    // 目标·锁定是「作用于谁」的全局配置，不进事件组；多个节点时取第一份。
    // 范围卡替代了目标卡时（合并），用范围卡上携带的 side/pick/count 兜底，避免 C.select 退回默认值。
    var selNodes = pick('select');
    if (!selNodes.length) {
      selNodes = pick('range').map(function (r) {
        var mt = Math.max(0, Math.round(numOr(r.maxTargets, 0)));
        return {
          side: r.side || 'enemyMany',
          pick: r.pick || 'nearest',
          count: r.count != null ? r.count : (mt > 0 ? Math.min(4, mt) : 4)
        };
      });
    }
    single.select = merge('select', selNodes);
    // 被动属性始终以技能原有 mods 为准（stats 节点只是它的可视化入口）
    single.stats = Object.assign(defaults('stats'), (skill && skill.mods) || {});
    /* 多个投射物不再 merge 成一份：旧逻辑把 speed / count / size 全部相加，
       两个投射物会凭空变成「速度 700、数量 4」。每个载体保留自己的完整属性，
       single.projectile 只作兼容兜底取第一份。 */
    var projNodes = pick('projectile');
    single.projectile = projNodes.length ? projNodes[0] : defaults('projectile');
    // 记录哪些单例节点真正接入了图（删除的模块不应再产生默认效果）
    var present = {};
    TYPES.forEach(function (t) { present[t] = pick(t).length > 0; });
    var active = live.some(function (x) {
      return x.type !== 'source' && x.type !== 'stats' && x.type !== 'status' && x.type !== 'range';
    }) && multi.source.some(function (s) { return s.enabled !== false; });

    /* 载体清单：每个载体一份独立 cfg + 绑定到它的节点清单 + parentId（载体嵌套） */
    var hosts = live.filter(function (x) { return HOST_TYPES[x.type]; }).map(function (x) {
      var cfg = Object.assign(defaults(x.type), x.params || {});
      var nm = String(cfg.name || '').trim();
      return {
        id: x.id, type: x.type, name: nm,
        label: HOST_LABELS[x.type] + (nm ? '「' + nm + '」' : ''),
        cfg: cfg, parentId: ownerOf[x.id] || '',
        bound: (boundOf[x.id] || []).slice(),
        scope: scoped[x.id]
      };
    });

    /* 护盾屏障是否在图里连到了像素特效模块：相连时原手绘护盾环交给特效表现。
       从每个 shield 节点沿 edges 正向 BFS，能到达 fx 节点即为「已连接」。 */
    var shieldHasFx = false;
    (function () {
      var typeOf = {}, next = {};
      (g.nodes || []).forEach(function (n) { if (n && n.id) typeOf[n.id] = n.type; });
      (g.edges || []).forEach(function (e) {
        if (!e || !e.from) return;
        (next[e.from] || (next[e.from] = [])).push(e.to);
      });
      var seen = {}, q = [];
      (g.nodes || []).forEach(function (n) {
        if (n && n.type === 'shield' && !seen[n.id]) { seen[n.id] = true; q.push(n.id); }
      });
      while (q.length && !shieldHasFx) {
        var cur = q.shift();
        (next[cur] || []).forEach(function (nx) {
          if (seen[nx]) return;
          seen[nx] = true;
          if (typeOf[nx] === 'fx') { shieldHasFx = true; return; }
          q.push(nx);
        });
      }
    })();

    /* 编辑器语义条的唯一数据源：每个节点最终属于哪个事件组 / 哪个宿主 / 累计延迟 / 命中判定。
       全部取自上面已算好的归一化结果，不再让编辑器自己猜一遍（避免「界面看着对、跑起来不对」）。 */
    var semantics = { byNode: {} };
    nodes.forEach(function (x) {
      var n = normalizedById[x.id];
      var host = (n && n._hostId) ? byId[n._hostId] : null;
      var hostName = host ? String((host.params || {}).name || '').trim() : '';
      semantics.byNode[x.id] = {
        type: x.type,
        event: (n && n._event) || '',
        hostId: (n && n._hostId) || '',
        hostType: host ? host.type : '',
        hostLabel: host ? (HOST_LABELS[host.type] + (hostName ? '「' + hostName + '」' : ''))
                        : (x.type === 'stats' ? '' : '技能整体'),
        delay: (n && Number(n._delay)) || 0,
        hitKind: (n && n._hitKind) || '',
        pathDot: !!(n && n._pathDot && n._pathDot.length),
        routed: !!(n && n._routedToPath)
      };
    });

    var result = {
      /* 技能名随编译结果一起带出：战斗记录 / 伤害统计按技能名归因，
         运行时的 C / C._viewOf 视图都能直接取到，不用再回查技能表。 */
      name: String((skill && skill.name) || '').slice(0, 24),
      sid: (skill && skill.id) || '',
      graph: g, nodes: nodes, liveIds: seen, present: present,
      projectileFx: groups.projectileFx, wallFx: groups.wallFx, wallHazard: groups.wallHazard,
      fxByHostNode: groups.fxByHostNode,
      sources: multi.source, elements: events.onHit.elements, fx: events.onHit.fx,
      particles: events.onHit.particles, damage: events.onHit.damage, impact: events.onHit.impact,
      stats: single.stats, projectile: single.projectile, targeted: single.targeted,
      select: single.select, shieldHasFx: shieldHasFx,
      events: events, active: active,
      hosts: hosts, bindings: { byNode: ownerOf, publicBucket: scoped[''] },
      rangeByHost: rangeByHost,
      semantics: semantics,
      charge: chargeOf(skill)
    };

    /* 预编译视图：对局与试放直接取用，杜绝「两端各算一遍归属」产生漂移。
       · public 视图 = 只有技能级公共节点
       · host  视图 = 公共节点 + 该载体专属节点；有专属弹体特效时优先替换公共外观 */
    function mkView(G, host, own, exclusive) {
      var ev = G.events;
      var V = Object.assign({}, result, {
        events: ev, projectileFx: G.projectileFx, wallFx: G.wallFx,
        wallHazard: G.wallHazard,
        elements: ev.onHit.elements, fx: ev.onHit.fx, particles: ev.onHit.particles,
        damage: ev.onHit.damage, impact: ev.onHit.impact,
        _isView: true, _exclusive: !!exclusive,
        _viewOf: host ? host.id : '', _hostType: host ? host.type : ''
      });
      if (host) {
        if (host.type === 'projectile') V.projectile = host.cfg;
        if (host.type === 'targeted') V.targeted = host.cfg;
        if (host.type === 'aura') V.aura = host.cfg;
        if (host.type === 'zone') V.zone = host.cfg;
        V.projectileFx = (own && own.projectileFx.length) ? own.projectileFx : (exclusive ? [] : pubGroups.projectileFx);
      } else V.projectileFx = pubGroups.projectileFx;
      if (exclusive) V.projectileFx = G.projectileFx;
      return V;
    }
    var viewCache = { public: mkView(pubGroups, null, null, false), hosts: {}, exclusive: {} };
    hosts.forEach(function (h) {
      var own = buildGroups(h.scope);
      var merged = buildGroups(joinBuckets(scoped[''], h.scope));
      viewCache.hosts[h.id] = mkView(merged, h, own, false);
      // 持续型载体：把专属节点跨事件摊平，作为「生成时表现 + 每次 tick 结算」的组
      // EX.events 仍按触发事件分组（施放表现只播 onCast 的专属节点）；
      // _tickGrp 才把四个事件组摊平，专供光环 / 区域这类没有「命中瞬间」的持续载体结算
      var flat = buildGroups(flattenBuckets(h.scope));
      var EX = mkView(own, h, own, true);
      EX._tickGrp = flat.events.onCast;
      viewCache.exclusive[h.id] = EX;
      h.tickGrp = EX._tickGrp;
    });
    result._views = viewCache;
    // 视图也要能反查宿主：运行时拿到的往往已是视图（PUB / q._C），仍要能找到光环的专属组
    var allViews = [viewCache.public];
    Object.keys(viewCache.hosts).forEach(function (k) { allViews.push(viewCache.hosts[k]); });
    Object.keys(viewCache.exclusive).forEach(function (k) { allViews.push(viewCache.exclusive[k]); });
    allViews.forEach(function (V) { V._views = viewCache; });
    // 把「路径特效 → 持续伤害」路由结果写回所有运行时视图（公共 / 各载体 / 专属）的
    // 特效与伤害节点上，避免多视图 copy 丢配置（对局与试放两边都吃这份编译结果）
    if (Object.keys(fxNodePathDot).length || Object.keys(routedDamageIds).length) {
      allViews.forEach(function (V) {
        var evs = V.events || {};
        Object.keys(evs).forEach(function (k) {
          var g = evs[k]; if (!g) return;
          (g.fx || []).forEach(function (f) {
            if (f && f._nodeId != null && fxNodePathDot[f._nodeId]) f._pathDot = fxNodePathDot[f._nodeId];
          });
          (g.damageList || []).forEach(function (d) {
            if (d && d._nodeId != null && routedDamageIds[d._nodeId]) d._routedToPath = true;
          });
        });
        // 专属视图的 tick 组（光环 / 区域每帧结算）也一并补上
        if (V._tickGrp) {
          (V._tickGrp.damageList || []).forEach(function (d) {
            if (d && d._nodeId != null && routedDamageIds[d._nodeId]) d._routedToPath = true;
          });
        }
      });
    }
    return result;
  }

  /* ---------------- 预设：可直接载入后继续魔改 ---------------- */
  function P(name, desc, tier, build, charge) { return { name: name, desc: desc, tier: tier, build: build, charge: charge || 0 }; }
  /** 预设专用：带端口的边（编辑器按端口画彩色线，编译仍按拓扑） */
  function E(from, fromPort, to, toPort) {
    return { from: from.id, fromPort: fromPort, to: to.id, toPort: toPort };
  }
  var PRESETS = [
    P('火球术', '单体火球：命中附加灼烧，可编辑数量/射程/反弹', 'common', function () {
      var s = node('source', 40, 80, { trigger: 'interval', interval: 2.4, delay: 0.6 });
      var e = node('element', 320, 20, { element: 'fire', color: '#ff7a30', damage: 18, damagePct: 1.5, status: 'burn', statusPower: 0.35, statusDuration: 3 });
      var d = node('damage', 320, 200, { base: 6, knockback: 60 });
      var p = node('projectile', 600, 20, { count: 1, speed: 340, size: 11, range: 900 });
      var f = node('fx', 880, 20, { effect: 'fire/fireball', scale: 0.9 });
      var im = node('impact', 880, 240, { aoeRadius: 46, aoePct: 0.35, shake: 0.18 });
      var pa = node('particles', 600, 250, { count: 16, color: '#ffd76a', color2: '#ff5a2a', attach: 'impact' });
      return makeGraph([s, e, d, p, f, im, pa], [
        { from: s.id, to: e.id }, { from: e.id, to: d.id }, { from: d.id, to: p.id },
        { from: p.id, to: f.id }, { from: p.id, to: im.id }, { from: im.id, to: pa.id }
      ]);
    }),
    P('霜火弹', '火焰 + 寒冰双元素：同时造成灼烧与减速，特效改冷色', 'rare', function () {
      var s = node('source', 40, 60, { trigger: 'interval', interval: 2.8 });
      var f1 = node('element', 320, 10, { element: 'fire', color: '#ff8a3a', damage: 14, damagePct: 1.2, status: 'burn' });
      var f2 = node('element', 320, 150, { element: 'ice', color: '#8ad8ff', damage: 12, damagePct: 1.0, status: 'slow', statusPower: 0.45 });
      var p = node('projectile', 620, 20, { count: 1, speed: 300, size: 13, range: 1100 });
      // 撞墙反弹属于运动行为：挂一个不推动弹体的「投射物绑定」运动器来承载（位移距离=0）
      var mo = node('motion', 620, 250, { scope: 'projectile', track: 'line', dirFrom: 'velocity', distance: 0, dieOnWall: false, wallBounce: 1 });
      var fx = node('fx', 900, 20, { effect: 'fire/fireball', scale: 1.2, additive: true, fxOptions: { palette: ['#10204a', '#22408c', '#3f78d0', '#78b8f0', '#d0f0ff', '#ff9a4a', '#ffd28a', '#ffffff'] } });
      var im = node('impact', 900, 250, { aoeRadius: 70, aoePct: 0.5, shake: 0.2 });
      return makeGraph([s, f1, f2, p, mo, fx, im], [
        { from: s.id, to: f1.id }, { from: s.id, to: f2.id }, { from: f1.id, to: p.id },
        { from: f2.id, to: p.id }, { from: p.id, to: mo.id }, { from: p.id, to: fx.id }, { from: p.id, to: im.id }
      ]);
    }),
    P('连环闪电', '三道高速闪电，命中后向附近连锁', 'epic', function () {
      var s = node('source', 40, 70, { trigger: 'interval', interval: 3.2 });
      var e = node('element', 320, 20, { element: 'lightning', color: '#9ad8ff', damage: 12, damagePct: 1, status: 'stun', statusDuration: 0.8, statusPower: 0.3 });
      var p = node('projectile', 320, 230, { count: 3, spread: 26, speed: 720, size: 6, gap: 0.04, range: 1400, trail: true });
      var fx = node('fx', 620, 20, { effect: 'lightning/chain-lightning', scale: 0.8, additive: true });
      var im = node('impact', 900, 20, { chainCount: 2, chainRange: 320, chainFalloff: 0.65, shake: 0.25, hitStop: 45 });
      return makeGraph([s, e, p, fx, im], [
        { from: s.id, to: e.id }, { from: e.id, to: p.id }, { from: p.id, to: fx.id }, { from: fx.id, to: im.id }
      ]);
    }),
    P('冰霜新星', '以自身为中心八向冻结飞弹，撞墙反弹两次', 'epic', function () {
      var s = node('source', 40, 60, { trigger: 'roundStart', delay: 0.8, maxCasts: 1 });
      var e = node('element', 320, 10, { element: 'ice', color: '#a8e8ff', damage: 10, damagePct: 1, status: 'freeze', statusDuration: 1.2, statusPower: 0.4 });
      var p = node('projectile', 320, 210, { count: 8, spread: 360, speed: 240, size: 9, range: 0, lifetime: 6 });
      var mo = node('motion', 320, 380, { scope: 'projectile', track: 'line', dirFrom: 'velocity', distance: 0, dieOnWall: false, wallBounce: 2 });
      var fx = node('fx', 620, 10, { effect: 'ice/frost-nova', attach: 'caster', scale: 1.6, loop: false });
      var f2 = node('fx', 620, 210, { effect: 'projectiles/magic-missile', scale: 0.6 });
      return makeGraph([s, e, p, mo, fx, f2], [
        { from: s.id, to: e.id }, { from: e.id, to: p.id }, { from: p.id, to: mo.id },
        { from: p.id, to: fx.id }, { from: p.id, to: f2.id }
      ]);
    }),
    P('奥术飞弹', '五发追踪飞弹，可穿透一个目标', 'rare', function () {
      var s = node('source', 40, 70, { trigger: 'interval', interval: 2 });
      var e = node('element', 320, 20, { element: 'arcane', color: '#c79cff', damage: 9, damagePct: 0.8 });
      var p = node('projectile', 320, 220, { count: 5, spread: 34, speed: 380, homing: 0.55, size: 7, pierce: 1, gap: 0.07, range: 1200 });
      var fx = node('fx', 620, 20, { effect: 'arcane/arcane-missiles', scale: 0.9 });
      var pa = node('particles', 620, 230, { count: 8, shape: 'circle', color: '#c79cff', color2: '#6a3ad0', attach: 'projectile', emitRate: 18, life: 0.4 });
      return makeGraph([s, e, p, fx, pa], [
        { from: s.id, to: e.id }, { from: e.id, to: p.id }, { from: p.id, to: fx.id }, { from: p.id, to: pa.id }
      ]);
    }),
    P('弹墙火球', '大号火球撞墙反弹 3 次，消失时爆炸', 'rare', function () {
      var s = node('source', 40, 70, { trigger: 'interval', interval: 4, maxCasts: 2 });
      var e = node('element', 320, 10, { element: 'fire', color: '#ff9a3a', damage: 22, damagePct: 2, status: 'burn' });
      var p = node('projectile', 320, 210, { count: 1, speed: 420, size: 18, range: 1800, lifetime: 8 });
      var mo = node('motion', 320, 380, { scope: 'projectile', track: 'line', dirFrom: 'velocity', distance: 0, dieOnWall: false, wallBounce: 3 });
      var fx = node('fx', 620, 10, { effect: 'fire/fireball', scale: 1.8 });
      var im = node('impact', 620, 230, { aoeRadius: 90, aoePct: 0.7, explodeOnWall: true, explodeOnExpire: true, shake: 0.3 });
      return makeGraph([s, e, p, mo, fx, im], [
        { from: s.id, to: e.id }, { from: e.id, to: p.id }, { from: p.id, to: mo.id },
        { from: p.id, to: fx.id }, { from: p.id, to: im.id }
      ]);
    }),
    P('指向 · 灼魂', '指向性持续引导：锁定对手 2 秒，每次结算叠一层灼烧印记', 'rare', function () {
      var s = node('source', 40, 90, { trigger: 'interval', interval: 2.8, delay: 0.5 });
      var tg = node('targeted', 330, 90, { applyMode: 'channel', delay: 0.2, channelDuration: 2, channelInterval: 0.5, tickOnStart: true });
      var e = node('element', 620, 10, { element: 'shadow', color: '#b98cff', damage: 9, status: 'burn', statusPower: 0.3, statusDuration: 3 });
      var m = node('mark', 620, 210, { stacks: 1, maxStacks: 5, duration: 5, damageAmp: 10, dotDps: 4, color: '#e8c85a' });
      return makeGraph([s, tg, e, m], [
        { from: s.id, to: tg.id }, { from: tg.id, to: e.id }, { from: tg.id, to: m.id }
      ]);
    }),
    /* ================= v4 端口样例（10 个果实） ================= */
    P('冰锥三连', '三发冰锥扇形散射：每发独立命中并减速，适合封走位', 'rare', function () {
      var s = node('source', 0, 0, { trigger: 'interval', interval: 3, delay: 0.4, aim: 'atEnemy' });
      var sel = node('select', 0, 0, { side: 'enemyOne', pick: 'nearest', count: 1 });
      var el = node('element', 0, 0, { triggerEvent: 'onHit', element: 'ice', color: '#8ad8ff', damage: 8, damagePct: 0.8, status: 'slow', statusPower: 0.4, statusDuration: 2 });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 6 });
      var p = node('projectile', 0, 0, { count: 3, spread: 26, speed: 340, size: 9, range: 780 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'ice/frost-breath', attach: 'projectile', scale: 0.8 });
      var pa = node('particles', 0, 0, { triggerEvent: 'onHit', count: 10, color: '#bfe8ff', color2: '#4aa8ff', attach: 'impact' });
      return makeGraph([s, sel, el, d, p, f, pa], [
        E(s, 'cast', sel, 'cast'), E(s, 'cast', el, 'cast'), E(el, 'cast', d, 'cast'),
        E(d, 'cast', p, 'cast'), E(sel, 'targets', p, 'targets'),
        E(p, 'entity', f, 'entity'), E(p, 'hit', pa, 'hit')
      ]);
    }, 4),
    P('雷霆领域', '以自身为圆心的雷暴：按血量优先抓 3 个敌人，命中附带短暂眩晕', 'epic', function () {
      var s = node('source', 0, 0, { trigger: 'roundStart', delay: 0.6, aim: 'atEnemy' });
      var rg = node('range', 0, 0, { bindTo: 'auto', side: 'enemyMany', count: 3, shape: 'circle', radius: 150, origin: 'caster', maxTargets: 3, pick: 'lowestHp', includeSelf: false });
      var el = node('element', 0, 0, { triggerEvent: 'onHit', element: 'lightning', color: '#9ad8ff', damage: 12, damagePct: 1.2, status: 'stun', statusPower: 0.3, statusDuration: 0.8 });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 14 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'ice/frost-nova', attach: 'host', scale: 1.3, fxOptions: { palette: ['#101a3a', '#1d3a72', '#2f6fc0', '#78c8ff', '#ffffff'] } });
      var im = node('impact', 0, 0, { triggerEvent: 'onHit', aoeRadius: 60, aoePct: 0.2, shake: 0.2 });
      return makeGraph([s, rg, el, d, f, im], [
        E(s, 'cast', rg, 'cast'),
        E(rg, 'hit', el, 'hit'), E(el, 'cast', d, 'cast'),
        E(rg, 'hit', f, 'hit'), E(rg, 'hit', im, 'hit')
      ]);
    }, 5),
    P('扇形霜爆', '面前 100° 扇形冻结：贴身打出高击退，专治绕后', 'rare', function () {
      var s = node('source', 0, 0, { trigger: 'roundStart', delay: 0.35, aim: 'atEnemy' });
      var rg = node('range', 0, 0, { bindTo: 'auto', side: 'enemyMany', count: 2, shape: 'cone', radius: 240, angleDeg: 100, origin: 'caster', maxTargets: 2, pick: 'nearest', includeSelf: false });
      var el = node('element', 0, 0, { triggerEvent: 'onHit', element: 'ice', color: '#a8e8ff', damage: 10, status: 'freeze', statusPower: 0.3, statusDuration: 1.5 });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 12, knockback: 30 });
      var im = node('impact', 0, 0, { triggerEvent: 'onHit', aoeRadius: 80, aoePct: 0.3, shake: 0.18 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'ice/frost-nova', attach: 'host', scale: 1.1 });
      return makeGraph([s, rg, el, d, im, f], [
        E(s, 'cast', rg, 'cast'),
        E(rg, 'hit', el, 'hit'), E(el, 'cast', d, 'cast'),
        E(rg, 'hit', im, 'hit'), E(rg, 'hit', f, 'hit')
      ]);
    }, 4),
    P('贯穿射线', '一条 1100 长的穿透射线：优先打最远的敌人，最多贯穿 4 个', 'epic', function () {
      var s = node('source', 0, 0, { trigger: 'interval', interval: 3.4, delay: 0.5, aim: 'atEnemy' });
      var rg = node('range', 0, 0, { bindTo: 'auto', side: 'enemyMany', count: 4, shape: 'line', length: 1100, width: 30, origin: 'caster', maxTargets: 4, pick: 'farthest' });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 16, armorPen: 10 });
      var el = node('element', 0, 0, { triggerEvent: 'onHit', element: 'lightning', color: '#9ad8ff', damage: 8, status: 'weaken', statusPower: 0.2, statusDuration: 2 });
      var pa = node('particles', 0, 0, { triggerEvent: 'onHit', count: 16, color: '#d0f0ff', color2: '#3f78d0', attach: 'path' });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'ice/frost-breath', attach: 'host', scale: 1.2 });
      return makeGraph([s, rg, d, el, pa, f], [
        E(s, 'cast', rg, 'cast'),
        E(rg, 'hit', d, 'hit'), E(rg, 'hit', el, 'hit'),
        E(rg, 'hit', pa, 'hit'), E(rg, 'hit', f, 'hit')
      ]);
    }, 5),
    P('毒雾陷阱', '在命中点留下一片毒雾：持续伤害 + 减速，适合锁住路口', 'rare', function () {
      var s = node('source', 0, 0, { trigger: 'roundStart', delay: 1.2, aim: 'atEnemy' });
      var sel = node('select', 0, 0, { side: 'enemyMany', pick: 'nearest', count: 4 });
      var zn = node('zone', 0, 0, { triggerEvent: 'onHit', radius: 120, duration: 5, dps: 7, slowPct: 0.25, color: '#7bd88a' });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 0, dotEnable: true, dotDps: 6, dotRadius: 120, dotFollow: 'caster', dotDuration: 5 });
      var st = node('status', 0, 0, { triggerEvent: 'onHit', status: 'poison', statusPower: 0.35, statusDuration: 4 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'nature/poison-cloud', attach: 'host', scale: 1.2, loop: false, life: 5 });
      return makeGraph([s, sel, zn, d, st, f], [
        E(s, 'cast', sel, 'cast'), E(s, 'cast', zn, 'cast'),
        E(zn, 'tick', d, 'tick'), E(zn, 'tick', st, 'tick'), E(zn, 'area', f, 'point')
      ]);
    }, 4),
    P('荆棘壁垒', '给自己套一层带反伤的护盾：抗住一波近身，靠反伤换血', 'common', function () {
      var s = node('source', 0, 0, { trigger: 'roundStart', delay: 0.2, aim: 'atEnemy' });
      var sel = node('select', 0, 0, { side: 'self', pick: 'nearest', count: 1 });
      var sh = node('shield', 0, 0, { triggerEvent: 'onCast', amount: 70, duration: 4, thorns: 0.35 });
      var f = node('fx', 0, 0, { triggerEvent: 'onCast', effect: 'holy/divine-shield', attach: 'caster', scale: 1 });
      var pa = node('particles', 0, 0, { triggerEvent: 'onCast', count: 10, color: '#ffe9a0', color2: '#e8c85a', attach: 'caster' });
      return makeGraph([s, sel, sh, f, pa], [
        E(s, 'cast', sel, 'cast'), E(sel, 'targets', sh, 'targets'),
        E(sh, 'cast', f, 'cast'), E(sh, 'cast', pa, 'cast')
      ]);
    }, 2.5),
    P('回旋月刃', '掷出后绕回自身的月刃：命中击退，贴身时能连续挂到', 'epic', function () {
      var s = node('source', 0, 0, { trigger: 'roundStart', delay: 0.4, aim: 'atEnemy' });
      var sel = node('select', 0, 0, { side: 'enemyOne', pick: 'nearest', count: 1 });
      var p = node('projectile', 0, 0, { count: 1, speed: 420, size: 10, range: 700 });
      var mo = node('motion', 0, 0, { triggerEvent: 'onCast', scope: 'projectile', track: 'arc', dirFrom: 'velocity', arcDeg: 60, distance: 260, duration: 0.8, endSpeed: 'restore', dieOnWall: false });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 18, knockback: 20 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'melee/heavy-cleave', attach: 'projectile', scale: 0.9, fxOptions: { palette: ['#0c2438', '#14486a', '#1f7a9c', '#4fc3d9', '#ffffff'] } });
      var pa = node('particles', 0, 0, { triggerEvent: 'onHit', count: 8, color: '#bff4ff', color2: '#2f8fc0', attach: 'projectile' });
      return makeGraph([s, sel, p, mo, d, f, pa], [
        E(s, 'cast', sel, 'cast'), E(sel, 'targets', p, 'targets'),
        E(p, 'entity', mo, 'entity'), E(mo, 'cast', d, 'cast'),
        E(p, 'entity', f, 'entity'), E(p, 'entity', pa, 'entity')
      ]);
    }, 4.5),
    P('连锁闪电', '指向性闪电命中后炸成 3 道小电弧，优先补刀残血', 'epic', function () {
      var s = node('source', 0, 0, { trigger: 'interval', interval: 3.2, delay: 0.35, aim: 'atEnemy' });
      var sel = node('select', 0, 0, { side: 'enemyOne', pick: 'lowestHp', count: 1 });
      var tg = node('targeted', 0, 0, { targetSide: 'enemy', applyMode: 'instant', maxRange: 900 });
      var el = node('element', 0, 0, { triggerEvent: 'onHit', element: 'lightning', color: '#a8d8ff', damage: 12, status: 'stun', statusPower: 0.3, statusDuration: 0.4 });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 10 });
      var sp = node('split', 0, 0, { triggerEvent: 'onHit', count: 3, spread: 360, speedScale: 70, sizeScale: 60, damageScale: 50, range: 260 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'ice/frost-nova', attach: 'host', scale: 1.1, fxOptions: { palette: ['#1a1030', '#3a1f6a', '#6a3ad0', '#b98cff', '#ffffff'] } });
      return makeGraph([s, sel, tg, el, d, sp, f], [
        E(s, 'cast', sel, 'cast'), E(sel, 'targets', tg, 'targets'),
        E(tg, 'hit', el, 'hit'), E(el, 'cast', d, 'cast'),
        E(tg, 'hit', sp, 'hit'), E(tg, 'hit', f, 'hit')
      ]);
    }, 5),
    P('印记引爆', '先叠 2 层光印，到期一起炸：层数越高单体爆发越强', 'rare', function () {
      var s = node('source', 0, 0, { trigger: 'roundStart', delay: 0.5, aim: 'atEnemy' });
      var sel = node('select', 0, 0, { side: 'enemyMany', pick: 'nearest', count: 2 });
      var mk = node('mark', 0, 0, { triggerEvent: 'onHit', stacks: 2, maxStacks: 5, duration: 4, stackMode: 'add', damageAmp: 12, detonate: 'onExpire', detonateDamage: 30, detonateRadius: 90, color: '#e8c85a' });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 6 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'fire/fireball', attach: 'impact', scale: 1.2, fxOptions: { palette: ['#2a1c08', '#6a4a12', '#c08a1a', '#ffd76a', '#ffffff'] } });
      return makeGraph([s, sel, mk, d, f], [
        E(s, 'cast', sel, 'cast'), E(sel, 'targets', mk, 'targets'),
        E(mk, 'cast', d, 'cast'), E(mk, 'cast', f, 'cast')
      ]);
    }, 4),
    P('延迟陨石', '蓄力 1.2 秒后砸下陨石：范围击退 + 持续灼烧，适合读走位', 'epic', function () {
      var s = node('source', 0, 0, { trigger: 'roundStart', delay: 0.3, aim: 'atEnemy' });
      var sel = node('select', 0, 0, { side: 'enemyMany', pick: 'nearest', count: 3 });
      var dl = node('delay', 0, 0, { seconds: 1.2 });
      var zn = node('zone', 0, 0, { triggerEvent: 'onHit', radius: 140, duration: 2, dps: 10, color: '#ff9a3a' });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 30, knockback: 40 });
      var im = node('impact', 0, 0, { triggerEvent: 'onHit', aoeRadius: 140, aoePct: 0.35, shake: 0.3 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'melee/heavy-cleave', attach: 'host', scale: 1.6, fxOptions: { palette: ['#2a0c10', '#5c1414', '#a3241a', '#e0481c', '#ff8a2a', '#ffc23d', '#fff0a0', '#ffffff'] } });
      return makeGraph([s, sel, dl, zn, d, im, f], [
        E(s, 'cast', sel, 'cast'), E(s, 'cast', dl, 'cast'), E(dl, 'cast', zn, 'cast'),
        E(zn, 'tick', d, 'tick'), E(zn, 'area', im, 'area'), E(im, 'cast', f, 'cast')
      ]);
    }, 6),
    /* ============ 像素特效定向样例（10 个，均避开现有果实已用的 effect） ============ */
    P('耀阳圣球', '一颗圣光球飞向最近敌人，命中炸出日耀环；附加易伤，适合起手标记', 'rare', function () {
      var s = node('source', 0, 0, { trigger: 'interval', interval: 3.2, delay: 0.4, aim: 'atEnemy' });
      var sel = node('select', 0, 0, { side: 'enemyOne', pick: 'nearest', count: 1 });
      var el = node('element', 0, 0, { triggerEvent: 'onHit', element: 'holy', color: '#ffe9a0', damage: 12, status: 'weaken', statusPower: 0.25, statusDuration: 2 });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 10 });
      var p = node('projectile', 0, 0, { count: 1, speed: 360, size: 10, range: 900 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'holy/sunburst', attach: 'host', scale: 1.1 });
      var im = node('impact', 0, 0, { triggerEvent: 'onHit', aoeRadius: 45, aoePct: 0.3, shake: 0.15 });
      return makeGraph([s, sel, el, d, p, f, im], [
        E(s, 'cast', sel, 'cast'), E(sel, 'targets', p, 'targets'),
        E(p, 'hit', el, 'hit'), E(el, 'cast', d, 'cast'),
        E(p, 'hit', im, 'hit'), E(p, 'entity', f, 'entity')
      ]);
    }, 4),
    P('冰棘突刺', '面前锥形范围钻出冰棘：两名最近敌人一起吃伤害并被减速', 'common', function () {
      var s = node('source', 0, 0, { trigger: 'roundStart', delay: 0.2, aim: 'atEnemy' });
      var rg = node('range', 0, 0, { bindTo: 'auto', side: 'enemyMany', count: 2, shape: 'cone', radius: 220, angleDeg: 90, origin: 'caster', maxTargets: 2, pick: 'nearest', includeSelf: false });
      var el = node('element', 0, 0, { triggerEvent: 'onHit', element: 'ice', color: '#a8e8ff', damage: 9, status: 'slow', statusPower: 0.4, statusDuration: 2 });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 8, knockback: 15 });
      var im = node('impact', 0, 0, { triggerEvent: 'onHit', aoeRadius: 50, aoePct: 0.25, shake: 0.12 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'ice/ice-spikes', attach: 'host', scale: 1 });
      return makeGraph([s, rg, el, d, im, f], [
        E(s, 'cast', rg, 'cast'),
        E(rg, 'hit', el, 'hit'), E(el, 'cast', d, 'cast'),
        E(rg, 'hit', im, 'hit'), E(rg, 'hit', f, 'hit')
      ]);
    }, 2.5),
    P('雷鸣震爆', '指向最近残血敌人落下雷柱：短眩晕 + 小范围雷爆，补刀稳定', 'rare', function () {
      var s = node('source', 0, 0, { trigger: 'interval', interval: 3.4, delay: 0.35, aim: 'atEnemy' });
      var sel = node('select', 0, 0, { side: 'enemyOne', pick: 'lowestHp', count: 1 });
      var tg = node('targeted', 0, 0, { targetSide: 'enemy', applyMode: 'instant', maxRange: 900 });
      var el = node('element', 0, 0, { triggerEvent: 'onHit', element: 'lightning', color: '#a8d8ff', damage: 12, status: 'stun', statusPower: 0.3, statusDuration: 0.6 });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 12 });
      var im = node('impact', 0, 0, { triggerEvent: 'onHit', aoeRadius: 65, aoePct: 0.3, shake: 0.2, hitStop: 35 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'lightning/thunderclap', attach: 'host', scale: 1.2 });
      return makeGraph([s, sel, tg, el, d, im, f], [
        E(s, 'cast', sel, 'cast'), E(sel, 'targets', tg, 'targets'),
        E(tg, 'hit', el, 'hit'), E(el, 'cast', d, 'cast'),
        E(tg, 'hit', im, 'hit'), E(tg, 'hit', f, 'hit')
      ]);
    }, 4),
    P('暗影虹吸', '暗影弹命中后抽取生命：自身回血，并让目标易伤', 'epic', function () {
      var s = node('source', 0, 0, { trigger: 'interval', interval: 4, delay: 0.3, aim: 'atEnemy' });
      var sel = node('select', 0, 0, { side: 'enemyOne', pick: 'nearest', count: 1 });
      var p = node('projectile', 0, 0, { count: 1, speed: 300, size: 9, range: 700 });
      var el = node('element', 0, 0, { triggerEvent: 'onHit', element: 'shadow', color: '#b98cff', damage: 6, status: 'weaken', statusPower: 0.2, statusDuration: 3 });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 14, lifesteal: 0.35 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'shadow/life-steal', attach: 'host', scale: 1.1 });
      return makeGraph([s, sel, p, el, d, f], [
        E(s, 'cast', sel, 'cast'), E(sel, 'targets', p, 'targets'),
        E(p, 'hit', el, 'hit'), E(el, 'cast', d, 'cast'),
        E(p, 'entity', f, 'entity')
      ]);
    }, 5),
    P('荆棘缠根', '脚下藤根缠住两名敌人：自然伤害 + 减速，适合拖住突进', 'common', function () {
      var s = node('source', 0, 0, { trigger: 'roundStart', delay: 0.25, aim: 'atEnemy' });
      var rg = node('range', 0, 0, { bindTo: 'auto', side: 'enemyMany', count: 2, shape: 'circle', radius: 120, origin: 'caster', maxTargets: 2, pick: 'nearest', includeSelf: false });
      var el = node('element', 0, 0, { triggerEvent: 'onHit', element: 'nature', color: '#8ad88a', damage: 8 });
      var st = node('status', 0, 0, { triggerEvent: 'onHit', status: 'slow', statusPower: 0.5, statusDuration: 2 });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 6 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'nature/root-snare', attach: 'host', scale: 1 });
      return makeGraph([s, rg, el, st, d, f], [
        E(s, 'cast', rg, 'cast'),
        E(rg, 'hit', el, 'hit'), E(rg, 'hit', st, 'hit'),
        E(st, 'cast', d, 'cast'), E(rg, 'hit', f, 'hit')
      ]);
    }, 2.5),
    P('水晶棱镜', '自身裹上冰晶护罩：护盾 + 反伤，纯防御向的保命果实', 'rare', function () {
      var s = node('source', 0, 0, { trigger: 'roundStart', delay: 0.2, aim: 'atEnemy' });
      var sel = node('select', 0, 0, { side: 'self', pick: 'nearest', count: 1 });
      var sh = node('shield', 0, 0, { triggerEvent: 'onCast', amount: 60, duration: 4, thorns: 0.2 });
      var f = node('fx', 0, 0, { triggerEvent: 'onCast', effect: 'ice/ice-crystal', attach: 'caster', scale: 1.3, loop: false });
      var pa = node('particles', 0, 0, { triggerEvent: 'onCast', count: 10, color: '#d0f0ff', color2: '#4aa8ff', attach: 'caster' });
      return makeGraph([s, sel, sh, f, pa], [
        E(s, 'cast', sel, 'cast'), E(sel, 'targets', sh, 'targets'),
        E(sh, 'cast', f, 'cast'), E(sh, 'cast', pa, 'cast')
      ]);
    }, 3.5),
    P('陨星火雨', '延迟 1.1 秒落下一片火雨：范围持续伤害 + 击退，读走位用', 'epic', function () {
      var s = node('source', 0, 0, { trigger: 'roundStart', delay: 0.3, aim: 'atEnemy' });
      var rg = node('range', 0, 0, { bindTo: 'auto', side: 'enemyMany', count: 3, shape: 'circle', radius: 130, origin: 'caster', maxTargets: 3, pick: 'lowestHp', includeSelf: false });
      var dl = node('delay', 0, 0, { seconds: 1.1 });
      var zn = node('zone', 0, 0, { triggerEvent: 'onHit', radius: 130, duration: 3, dps: 8, slowPct: 0.15, color: '#ff8a3a' });
      var d = node('damage', 0, 0, { triggerEvent: 'onTick', base: 0, dotEnable: true, dotDps: 6, dotRadius: 130, dotDuration: 3 });
      var im = node('impact', 0, 0, { triggerEvent: 'onHit', aoeRadius: 130, aoePct: 0.4, shake: 0.3 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'fire/meteor', attach: 'point', scale: 1.5, loop: false, life: 3 });
      return makeGraph([s, dl, rg, zn, d, im, f], [
        E(s, 'cast', dl, 'cast'), E(dl, 'cast', rg, 'cast'),
        E(rg, 'area', zn, 'area'),
        E(zn, 'tick', d, 'tick'), E(zn, 'area', im, 'area'), E(im, 'cast', f, 'cast')
      ]);
    }, 6),
    P('晶盘回旋', '掷出能量晶盘，绕一道弧线切回：命中击退，适合封侧身', 'rare', function () {
      var s = node('source', 0, 0, { trigger: 'roundStart', delay: 0.4, aim: 'atEnemy' });
      var sel = node('select', 0, 0, { side: 'enemyOne', pick: 'nearest', count: 1 });
      var p = node('projectile', 0, 0, { count: 1, speed: 430, size: 9, range: 650 });
      var mo = node('motion', 0, 0, { triggerEvent: 'onCast', scope: 'projectile', track: 'arc', arcDeg: 50, distance: 220, duration: 0.7, endSpeed: 'restore', dieOnWall: false });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 15, knockback: 10 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'projectiles/energy-disc', attach: 'projectile', scale: 1 });
      return makeGraph([s, sel, p, mo, d, f], [
        E(s, 'cast', sel, 'cast'), E(sel, 'targets', p, 'targets'),
        E(p, 'entity', mo, 'entity'), E(mo, 'cast', d, 'cast'),
        E(p, 'entity', f, 'entity')
      ]);
    }, 4),
    P('涌泉漩涡', '目标脚下涌出漩涡：持续伤害并把敌人往中心拖慢', 'rare', function () {
      var s = node('source', 0, 0, { trigger: 'roundStart', delay: 0.6, aim: 'atEnemy' });
      var rg = node('range', 0, 0, { bindTo: 'auto', side: 'enemyMany', count: 3, shape: 'circle', radius: 120, origin: 'caster', maxTargets: 3, pick: 'lowestHp', includeSelf: false });
      var zn = node('zone', 0, 0, { triggerEvent: 'onHit', radius: 120, duration: 4, dps: 5, slowPct: 0.4, color: '#5ac8fa' });
      var d = node('damage', 0, 0, { triggerEvent: 'onTick', base: 0, dotEnable: true, dotDps: 5, dotRadius: 120, dotDuration: 4 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'water/whirlpool', attach: 'host', scale: 1.2, loop: true, life: 4 });
      return makeGraph([s, rg, zn, d, f], [
        E(s, 'cast', rg, 'cast'), E(rg, 'area', zn, 'area'),
        E(zn, 'tick', d, 'tick'), E(rg, 'hit', f, 'hit')
      ]);
    }, 4),
    P('大地裂击', '正面锥形地裂：地刺顶起两名敌人并击退，简单直接', 'common', function () {
      var s = node('source', 0, 0, { trigger: 'interval', interval: 2.8, delay: 0.25, aim: 'atEnemy' });
      var rg = node('range', 0, 0, { bindTo: 'auto', side: 'enemyMany', count: 2, shape: 'cone', radius: 240, angleDeg: 80, origin: 'caster', maxTargets: 2, pick: 'nearest', includeSelf: false });
      var el = node('element', 0, 0, { triggerEvent: 'onHit', element: 'nature', color: '#d8b878', damage: 10 });
      var d = node('damage', 0, 0, { triggerEvent: 'onHit', base: 8, knockback: 20 });
      var im = node('impact', 0, 0, { triggerEvent: 'onHit', aoeRadius: 70, aoePct: 0.25, shake: 0.18 });
      var f = node('fx', 0, 0, { triggerEvent: 'onHit', effect: 'nature/earth-spike', attach: 'host', scale: 1.1 });
      return makeGraph([s, rg, el, d, im, f], [
        E(s, 'cast', rg, 'cast'),
        E(rg, 'hit', el, 'hit'), E(el, 'cast', d, 'cast'),
        E(rg, 'hit', im, 'hit'), E(rg, 'hit', f, 'hit')
      ]);
    }, 2.5)
  ];

  var api = {
    MODULES: MODULES, TYPES: TYPES, ELEMENTS: ELEMENTS, STATUSES: STATUSES, ATTACH: ATTACH, ENEMY_PICK: ENEMY_PICK,
    GROUPS: GROUPS, GROUP_ORDER: GROUP_ORDER, WALL_MODES: WALL_MODES,
    MOTION_LEGACY: MOTION_LEGACY, normalizeMotion: normalizeMotion,
    PRESETS: PRESETS, defaults: defaults, node: node, uid: uid, starterGraph: starterGraph,
    compile: compile, makeGraph: makeGraph, DEFAULT_CHARGE: DEFAULT_CHARGE, chargeOf: chargeOf,
    hitHasContent: hitHasContent,
    HIT_KIND_LABEL: HIT_KIND_LABEL, damageKindOf: damageKindOf, damageAcceptsKind: damageAcceptsKind,
    onHitNeedsContact: onHitNeedsContact, damageNodesFor: damageNodesFor,
    selectTargets: selectTargets, skillKnockback: skillKnockback, skillNeedsContact: skillNeedsContact,
    HOST_TYPES: HOST_TYPES, HOST_LABELS: HOST_LABELS, setHosts: setHosts,
    publicView: publicView, viewFor: viewFor, hostsOf: hostsOf, describeBindings: describeBindings,
    exclusiveView: exclusiveView, viewOfNode: viewOfNode,
    rangeDescriptor: rangeDescriptor, rangePoint: rangePoint, rangeLabel: rangeLabel,
    inRangeShape: inRangeShape, targetsInRange: targetsInRange,
    moduleInRange: moduleInRange, moduleTargets: moduleTargets,
    normWall: normWall, wallHazardOf: wallHazardOf, wallDamageOf: wallDamageOf,
    // 职业系统已移除：保留空实现以兼容可能的残留调用，不再引用任何字段
    setClasses: function () {}
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkillModules = api;
})(typeof window !== 'undefined' ? window : globalThis);
