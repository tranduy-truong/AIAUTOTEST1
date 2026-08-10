export interface ElementInfo {
  tag: string;
  type?: string;
  role?: string;
  placeholder?: string;
  ariaLabel?: string;
  text?: string;
  testId?: string;
  dataSlot?: string;
  dataValue?: string;
  id?: string;
  name?: string;
  className?: string;
  title?: string;
  accessibleName?: string;
  nearbyInputPlaceholder?: string;
  labelText?: string;
  scopeSelector?: string;
  ariaHasPopup?: string;
  selector?: string;
  isVisible: boolean;
}

export interface DomSnapshot {
  url: string;
  afterStep: string;
  elements: ElementInfo[];
}

export interface ResolvedLocator {
  locator: string;          // e.g. "page.getByPlaceholder('Nhập tên đăng nhập')"
  confidence: 'high' | 'medium' | 'low';
  matchedBy: string;        // e.g. "placeholder", "role+name", "text"
  element?: ElementInfo;    // DOM evidence used to create this locator
}

/**
 * Hàm chuẩn hóa chuỗi để tìm kiếm mờ (fuzzy match)
 * Bỏ dấu, chuyển chữ thường, xóa khoảng trắng thừa
 */
function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/đ/g, 'd')
    .replace(/^['"]|['"]$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function textMatches(candidate: string | undefined, target: string): boolean {
  const normalizedCandidate = normalizeText(candidate || '');
  return Boolean(
    normalizedCandidate &&
    target &&
    (normalizedCandidate.includes(target) || target.includes(normalizedCandidate))
  );
}

function uniqueVisibleMatch(
  elements: ElementInfo[],
  predicate: (element: ElementInfo) => boolean,
): ElementInfo | undefined {
  const matches = elements.filter(element => element.isVisible && predicate(element));
  const uniqueTargets = new Map<string, ElementInfo>();
  for (const element of matches) {
    const key = element.selector || JSON.stringify([
      element.tag,
      element.role,
      element.accessibleName,
      element.placeholder,
      element.text,
      element.id,
      element.name,
    ]);
    if (!uniqueTargets.has(key)) uniqueTargets.set(key, element);
  }
  return uniqueTargets.size === 1 ? [...uniqueTargets.values()][0] : undefined;
}

function uniqueVisibleMatchPreferringScope(
  elements: ElementInfo[],
  predicate: (element: ElementInfo) => boolean,
): ElementInfo | undefined {
  const scopedElements = elements.filter(element => element.isVisible && element.scopeSelector);
  const scopedMatch = uniqueVisibleMatch(scopedElements, predicate);
  return scopedMatch || uniqueVisibleMatch(elements, predicate);
}

function escapeSingleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function findIconElement(target: string, elements: ElementInfo[]): ElementInfo | undefined {
  let keywords: string[] = [];
  let needsPasswordNeighbor = false;

  if (target.includes('con mat') || target.includes('eye') || target.includes('mat khau')) {
    keywords = ['eye', 'password', 'mat khau', 'hien mat khau', 'an mat khau', 'toggle password'];
    needsPasswordNeighbor = true;
  } else if (target.includes('chinh sua') || target.includes('sua') || target.includes('edit') || target.includes('pencil')) {
    keywords = ['chinh sua', 'sua', 'edit', 'pencil'];
  } else if (target.includes('xoa') || target.includes('delete') || target.includes('trash')) {
    keywords = ['xoa', 'delete', 'trash'];
  } else if (target.includes('them') || target.includes('add') || target.includes('plus')) {
    keywords = ['them', 'add', 'plus'];
  }

  if (keywords.length === 0) return undefined;

  const scored = elements
    .filter(el => el.isVisible && el.selector)
    .map(el => {
      const semanticText = normalizeText([
        el.accessibleName,
        el.ariaLabel,
        el.title,
        el.testId,
        el.id,
        el.className,
        el.text,
      ].filter(Boolean).join(' '));
      const nearbyInput = normalizeText(el.nearbyInputPlaceholder || '');
      let score = keywords.reduce((total, keyword) => total + (semanticText.includes(keyword) ? 3 : 0), 0);
      if (needsPasswordNeighbor && nearbyInput.includes('mat khau')) score += 5;
      if (el.tag === 'button' || el.role === 'button') score += 2;
      if (el.tag === 'svg' || el.tag === 'i') score += 1;
      return { el, score };
    })
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.el;
}

/**
 * Phân giải mô tả phần tử thành locator Playwright
 * @param stepType Loại hành động (fill, click, select, check)
 * @param stepTarget Mô tả phần tử đích
 * @param dom Snapshot DOM để đối chiếu
 * @returns Thông tin locator và độ tin cậy
 */
export function resolveLocator(
  stepType: string,
  stepTarget: string,
  dom?: DomSnapshot
): ResolvedLocator {
  const target = normalizeText(stepTarget);
  const elements = dom?.elements || [];

  // 1. Xử lý bước 'fill' (nhập liệu)
  if (stepType === 'fill') {
    // a. Tìm theo placeholder (độ tin cậy cao)
    const byPlaceholder = uniqueVisibleMatch(elements, el => textMatches(el.placeholder, target));
    if (byPlaceholder && byPlaceholder.placeholder) {
      return {
        locator: `page.getByPlaceholder('${byPlaceholder.placeholder}')`,
        confidence: 'high',
        matchedBy: 'placeholder',
        element: byPlaceholder
      };
    }

    // b. Tìm theo ariaLabel (độ tin cậy cao)
    const byAriaLabel = uniqueVisibleMatch(elements, el =>
      (el.tag === 'input' || el.tag === 'textarea') &&
      (textMatches(el.ariaLabel, target) || textMatches(el.labelText, target)),
    );
    if (byAriaLabel) {
      if (byAriaLabel.ariaLabel) {
        return {
          locator: `page.getByLabel('${escapeSingleQuoted(byAriaLabel.ariaLabel)}')`,
          confidence: 'high',
          matchedBy: 'ariaLabel',
          element: byAriaLabel
        };
      }
      if (byAriaLabel.selector) {
        return {
          locator: `page.locator('${escapeSingleQuoted(byAriaLabel.selector)}')`,
          confidence: 'high',
          matchedBy: 'verified_field_label',
          element: byAriaLabel,
        };
      }
    }

    // c. Tìm theo name (độ tin cậy trung bình)
    const byName = uniqueVisibleMatch(elements, el => textMatches(el.name, target));
    if (byName && byName.name) {
      return {
        locator: `page.locator('[name="${byName.name}"]')`,
        confidence: 'medium',
        matchedBy: 'name',
        element: byName
      };
    }

    // d. Tìm theo id (độ tin cậy trung bình)
    const byId = uniqueVisibleMatch(elements, el => textMatches(el.id, target));
    if (byId && byId.id) {
      return {
        locator: `page.locator('#${byId.id}')`,
        confidence: 'medium',
        matchedBy: 'id',
        element: byId
      };
    }

    // e. Fallback nhập liệu (dùng getByPlaceholder kết hợp getByLabel và first)
    const cleanTarget = stepTarget.replace(/^['"]|['"]$/g, '').replace(/'/g, "\\'");
    return {
      locator: `page.getByPlaceholder('${cleanTarget}').or(page.getByLabel('${cleanTarget}')).first()`,
      confidence: 'low',
      matchedBy: 'fallback_placeholder'
    };
  }

  // 2. Xử lý bước 'click' (nhấn)
  if (stepType === 'click') {
    const cleanTarget = stepTarget.replace(/^['"]|['"]$/g, '').replace(/'/g, "\\'");
    
    // a. Tìm button hoặc link có text trùng khớp (độ tin cậy cao)
    const isButtonOrLink = (el: ElementInfo) => el.tag === 'button' || el.tag === 'a' || el.role === 'button' || el.role === 'link';
    const byText = uniqueVisibleMatch(elements, el =>
      isButtonOrLink(el) && (
        textMatches(el.text, target) ||
        textMatches(el.accessibleName, target) ||
        textMatches(el.ariaLabel, target)
      ),
    );
    
    if (byText && byText.text) {
      const role = (byText.tag === 'a' || byText.role === 'link') ? 'link' : 'button';
      const safeName = escapeSingleQuoted((byText.accessibleName || byText.text).trim());
      return {
        locator: `page.getByRole('${role}', { name: '${safeName}', exact: true })`,
        confidence: 'high',
        matchedBy: 'role+name',
        element: byText
      };
    }

    // Frameworks sometimes render a clickable div/span. Only use it when the
    // live snapshot provides a unique selector; never infer a CSS class.
    const byVerifiedInteractiveText = uniqueVisibleMatch(elements, el =>
      Boolean(el.selector) &&
      (Boolean(el.ariaHasPopup) || el.role === 'button' || el.role === 'menuitem') &&
      (
        textMatches(el.text, target) ||
        textMatches(el.accessibleName, target) ||
        textMatches(el.ariaLabel, target)
      ),
    );
    if (byVerifiedInteractiveText?.selector) {
      return {
        locator: `page.locator('${escapeSingleQuoted(byVerifiedInteractiveText.selector)}')`,
        confidence: 'high',
        matchedBy: 'verified_interactive_text',
        element: byVerifiedInteractiveText,
      };
    }

    // b. Icon chỉ được resolve khi snapshot DOM cung cấp bằng chứng thực tế.
    const iconElement = findIconElement(target, elements);
    if (iconElement?.selector) {
      const safeSelector = iconElement.selector.replace(/'/g, "\\'");
      const hasAccessibleEvidence = Boolean(iconElement.ariaLabel || iconElement.accessibleName || iconElement.testId);
      return {
        locator: `page.locator('${safeSelector}')`,
        confidence: hasAccessibleEvidence ? 'high' : 'medium',
        matchedBy: 'dom_icon_metadata',
        element: iconElement
      };
    }

    // c. Tìm theo ariaLabel (độ tin cậy trung bình)
    const byAriaLabel = uniqueVisibleMatch(elements, el => textMatches(el.ariaLabel, target));
    if (byAriaLabel && byAriaLabel.ariaLabel) {
      const safeLabel = byAriaLabel.ariaLabel.replace(/'/g, "\\'");
      return {
        locator: `page.getByLabel('${safeLabel}')`,
        confidence: 'medium',
        matchedBy: 'ariaLabel',
        element: byAriaLabel
      };
    }

    // d. Tìm link có text (độ tin cậy trung bình)
    const linkByText = elements.find(el => (el.tag === 'a' || el.role === 'link') && el.text && normalizeText(el.text).includes(target));
    if (linkByText && linkByText.text) {
      const safeName = linkByText.text.trim().replace(/'/g, "\\'");
      return {
        locator: `page.getByRole('link', { name: '${safeName}', exact: true })`,
        confidence: 'medium',
        matchedBy: 'link_name',
        element: linkByText
      };
    }

    // e. Fallback an toàn (Ưu tiên getByRole button -> fallback getByText với .first() tránh strict mode)
    return {
      locator: `page.getByRole('button', { name: '${cleanTarget}' }).or(page.getByText('${cleanTarget}')).first()`,
      confidence: 'low',
      matchedBy: 'fallback_role_button'
    };
  }

  // 3. Xử lý bước 'select' (chọn dropdown)
  if (stepType === 'select') {
    const cleanTarget = stepTarget.replace(/^['"]|['"]$/g, '').replace(/'/g, "\\'");

    const isDropdown = (el: ElementInfo) =>
      el.tag === 'select' || el.role === 'combobox' || el.ariaHasPopup === 'listbox';

    // a. Accessible label, associated label, placeholder or visible trigger text.
    const dropdown = uniqueVisibleMatchPreferringScope(elements, el =>
      isDropdown(el) && [
        el.ariaLabel,
        el.accessibleName,
        el.labelText,
        el.placeholder,
        el.text,
      ].some(candidate => textMatches(candidate, target)),
    );
    if (dropdown) {
      if (dropdown.selector) {
        return {
          locator: `page.locator('${escapeSingleQuoted(dropdown.selector)}')`,
          confidence: 'high',
          matchedBy: 'verified_dropdown_trigger',
          element: dropdown,
        };
      }
    }

    // b. A unique label can point at a sibling custom trigger.
    const byLabelText = uniqueVisibleMatch(elements, el =>
      el.tag === 'label' && textMatches(el.text, target) && Boolean(el.selector),
    );
    if (byLabelText?.selector) {
      return {
        locator: `page.locator('${escapeSingleQuoted(byLabelText.selector)}')`,
        confidence: 'medium',
        matchedBy: 'verified_dropdown_label',
        element: byLabelText,
      };
    }

    return {
      locator: `page.getByRole('combobox', { name: '${cleanTarget}' })`,
      confidence: 'low',
      matchedBy: 'fallback_dropdown'
    };
  }

  // 4. Resolve an option only after the Crawler opened the dropdown and
  // captured the overlay/listbox state.
  if (stepType === 'option') {
    const option = uniqueVisibleMatch(elements, el =>
      (el.role === 'option' || el.tag === 'option' || el.role === 'menuitem') &&
      (
        textMatches(el.text, target) ||
        textMatches(el.accessibleName, target) ||
        textMatches(el.dataValue, target)
      ),
    );
    if (option) {
      if (option.role === 'option' || option.tag === 'option') {
        const safeName = escapeSingleQuoted((option.accessibleName || option.text || stepTarget).trim());
        return {
          locator: `page.getByRole('option', { name: '${safeName}', exact: true })`,
          confidence: 'high',
          matchedBy: 'verified_option',
          element: option,
        };
      }
      if (option.selector) {
        return {
          locator: `page.locator('${escapeSingleQuoted(option.selector)}')`,
          confidence: 'high',
          matchedBy: 'verified_option_selector',
          element: option,
        };
      }
    }

    const verifiedTextOption = uniqueVisibleMatch(elements, el =>
      Boolean(el.selector) && textMatches(el.text, target),
    );
    if (verifiedTextOption?.selector) {
      return {
        locator: `page.locator('${escapeSingleQuoted(verifiedTextOption.selector)}')`,
        confidence: 'medium',
        matchedBy: 'verified_option_text',
        element: verifiedTextOption,
      };
    }
    return {
      locator: `page.getByRole('option', { name: '${escapeSingleQuoted(stepTarget)}', exact: true })`,
      confidence: 'low',
      matchedBy: 'fallback_option',
    };
  }

  // 5. Xử lý bước 'check' (kiểm tra/assert)
  if (stepType === 'check') {
    const originalTarget = stepTarget.replace(/^['"]|['"]$/g, '');
    const safeOriginal = originalTarget.replace(/'/g, "\\'");
    
    if (target.includes('url khong con chua')) {
      const match = stepTarget.match(/['"](.*?)['"]/);
      const slug = match ? match[1] : 'dang-nhap';
      return {
        locator: `await expect(page).not.toHaveURL(/.*${slug}.*/i);`,
        confidence: 'high',
        matchedBy: 'assert_url_not_contains'
      };
    }
    if (target.includes('url chua')) {
      const match = stepTarget.match(/['"](.*?)['"]/);
      const slug = match ? match[1] : 'dang-nhap';
      return {
        locator: `await expect(page).toHaveURL(/.*${slug}.*/i);`,
        confidence: 'high',
        matchedBy: 'assert_url_contains'
      };
    }
    if (target.includes('thong bao co chu') || target.includes('hien thi text') || target.includes('xuat hien') || target.includes('co thong bao')) {
      const match = stepTarget.match(/['"](.*?)['"]/);
      const textToFind = match ? match[1] : originalTarget;
      const safeText = textToFind.replace(/'/g, "\\'");
      return {
        locator: `await expect(page.getByText('${safeText}')).toBeVisible();`,
        confidence: 'high',
        matchedBy: 'assert_text_visible'
      };
    }
    if (
      target.includes('mat khau dang an') ||
      target.includes('mat khau quay lai dang an') ||
      target.includes('mat khau bi an')
    ) {
      return {
        locator: `await expect(page.getByPlaceholder('Nhập mật khẩu')).toHaveAttribute('type', 'password');`,
        confidence: 'high',
        matchedBy: 'assert_password_hidden'
      };
    }
    if (
      target.includes('mat khau dang van ban') ||
      target.includes('mat khau chuyen sang dang van ban') ||
      (target.includes('mat khau') && target.includes('doc duoc'))
    ) {
      return {
        locator: `await expect(page.getByPlaceholder('Nhập mật khẩu')).toHaveAttribute('type', 'text');`,
        confidence: 'high',
        matchedBy: 'assert_password_visible'
      };
    }
    
    // Fallback assert
    return {
      locator: `await expect(page.locator('body')).toContainText('${safeOriginal}');`,
      confidence: 'low',
      matchedBy: 'fallback_assert'
    };
  }

  // Mặc định trả về theo text nếu không xác định được loại
  return {
    locator: `page.getByText('${stepTarget.replace(/^['"]|['"]$/g, '')}')`,
    confidence: 'low',
    matchedBy: 'unknown_step_type'
  };
}
