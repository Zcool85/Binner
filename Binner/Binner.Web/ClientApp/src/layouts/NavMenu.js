import React, { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Collapse, Container, Navbar, NavbarBrand, NavbarToggler, NavItem, NavLink } from "reactstrap";
import { Form, Input, Icon, Popup } from "semantic-ui-react";
import { AppEvents, Events } from "../common/events";
import "./NavMenu.css";

export function NavMenu(props) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const navigate = useNavigate();

  const toggleNavbar = () => {
    setCollapsed(!collapsed);
  };

  const handleChange = (e, control) => {
    switch (control.name) {
      case "searchKeyword":
        setSearchKeyword(control.value);
        break;
      default:
        break;
    }
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setSearchKeyword("");
    navigate(`/inventory?keyword=${searchKeyword}`, { replace: true });
  };

  return (
    <header>
      <Navbar className="navbar-expand-sm navbar-toggleable-sm ng-white border-bottom box-shadow mb-3" light>
        <Container className={"binner-container"}>
          <NavbarBrand tag={Link} to="/" />
          <NavbarToggler onClick={toggleNavbar} className="mr-2" />
          <Collapse className="d-sm-inline-flex flex-sm-row-reverse" isOpen={!collapsed} navbar>
            <Form onSubmit={onSubmit}>
              <ul className="navbar-nav flex-grow">
                <NavItem style={{lineHeight: '2.3'}}>
                  <Popup 
                    position="left center"
                    content={t('comp.navBar.help', "Help")}
                    trigger={<Link to="/help" className="help-icon"><Icon name="help circle" /></Link>}
                  />
                </NavItem>
                <NavItem>
                  <Input
                    icon={{ name: "search", circular: true, link: true, onClick: onSubmit }}
                    size="mini"
                    placeholder={t('comp.navBar.search', "Search")}
                    onChange={handleChange}
                    value={searchKeyword}
                    name="searchKeyword"
                    onFocus={() => AppEvents.sendEvent(Events.DisableBarcodeInput)}
                    onBlur={() => AppEvents.sendEvent(Events.RestoreBarcodeInput)}
                  />
                </NavItem>
                <NavItem>
                  <NavLink tag={Link} className="text-dark" to="/">
                  {t('comp.navBar.home', "Home")}
                  </NavLink>
                </NavItem>
                <NavItem>
                  <NavLink tag={Link} className="text-dark" to="/inventory/add">
                  {t('comp.navBar.addInventory', "Add Inventory")}
                  </NavLink>
                </NavItem>
                <NavItem>
                  <NavLink tag={Link} className="text-dark" to="/import">
                  {t('comp.navBar.orderImport', "Order Import")}
                  </NavLink>
                </NavItem>
              </ul>
            </Form>
          </Collapse>
        </Container>
      </Navbar>
    </header>
  );
}
